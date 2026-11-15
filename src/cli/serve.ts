// `okf serve`: the plugin's MCP server without Obsidian (ADR 0009). It serves while no loaded
// plugin holds state/server.lock, and hands the port over when one does.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, appendFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import manifest from "../../manifest.json";
import { NodeFilePort, NodeVault, nodeStateAdapter, nodeVaultPort } from "../node/ports";
import { daemonRunning, holdDaemonPipe, lockHeld, readDaemon, writeDaemon, type DaemonStatus } from "../node/handoff";
import { sanitizeSettings, type PluginSettings } from "../obsidian/settings";
import { FileAuditLog, FileSnapshotStore, FileTrustLedger } from "../obsidian/stateStore";
import { VaultBundleSource } from "../obsidian/vaultBundleSource";
import { OkfHttpServer } from "../server/httpServer";
import { TokenStore } from "../server/tokens";
import { autoApproveRule } from "../service/autoApprove";
import { KnowledgeService } from "../service/knowledgeService";
import { WriteService } from "../service/writeService";

export const PLUGIN_ID = "okf-wiki";
export const VERSION: string = manifest.version;
const POLL_MS = 1_000;
/** After a failed start (usually the port still held), wait this long before loading the vault again. */
const RETRY_MS = 10_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export const READ_ONLY_NOTE =
  "Obsidian is closed, so this server is read-only until it opens. Do not retry writes; tell the person if you need to write.";
export const WRITABLE_NOTE =
  "Obsidian is closed. Writes work, and new concepts wait for a person to approve them when Obsidian opens.";

export interface ServeOptions {
  vault: string;
  configDir: string;
}

interface Running {
  server: OkfHttpServer;
  source: VaultBundleSource;
  trust: FileTrustLedger;
  writes: WriteService | undefined;
  flush: NodeJS.Timeout;
}

export class Daemon {
  readonly vault: NodeVault;
  /** Vault-relative, for the state store; and absolute, for the hand-over files. */
  readonly stateRel: string;
  readonly stateAbs: string;
  private running: Running | null = null;
  private settings: PluginSettings | null = null;
  private dataStamp = "";
  private lastError = "";
  private busy = false;
  private reported = "";
  private retryAt = 0;

  constructor(readonly options: ServeOptions, private readonly print: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
    this.vault = new NodeVault(resolve(options.vault), options.configDir);
    this.stateRel = `${options.configDir}/plugins/${PLUGIN_ID}/state`;
    this.stateAbs = this.vault.abs(this.stateRel);
    mkdirSync(this.stateAbs, { recursive: true });
  }

  get serving(): boolean {
    return this.running !== null;
  }

  log(message: string, error?: unknown): void {
    const line = `${new Date().toISOString()} ${message}${error ? ` ${error instanceof Error ? error.message : String(error)}` : ""}`;
    this.print(line);
    const file = join(this.stateAbs, "daemon.log");
    try {
      if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, join(this.stateAbs, "daemon.1.log"));
      appendFileSync(file, `${line}\n`);
    } catch {
      // Logging must never stop the server.
    }
  }

  /** Write daemon.json when the state changes, not on every tick. */
  report(status: Omit<DaemonStatus, "pid" | "at">): void {
    const key = JSON.stringify(status);
    if (key === this.reported) return;
    this.reported = key;
    writeDaemon(this.stateAbs, status);
  }

  private dataFile(): string {
    return this.vault.abs(`${this.options.configDir}/plugins/${PLUGIN_ID}/data.json`);
  }

  /** One step of the loop: serve or release to match the lock. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (lockHeld(this.stateAbs)) {
        if (this.running) {
          await this.release();
          this.log("released the port to Obsidian");
        }
        this.report({ version: VERSION, state: "released", writes: false });
        this.dataStamp = "";
      } else if (!this.running) {
        await this.tryStart();
      }
    } finally {
      this.busy = false;
    }
  }

  private async tryStart(): Promise<void> {
    if (Date.now() < this.retryAt) return;
    let stamp = "missing";
    try {
      stamp = String(statSync(this.dataFile()).mtimeMs);
    } catch {
      // No data.json: the plugin was never set up in this vault.
    }
    // Retry only when the settings changed, so a vault with nothing to serve does not spin.
    if (stamp === this.dataStamp) return;
    this.dataStamp = stamp;
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.dataFile(), "utf8"));
    } catch {
      raw = {};
    }
    const settings = (this.settings = sanitizeSettings(raw));
    const idle = (error: string) => {
      if (error !== this.lastError) this.log(error);
      this.lastError = error;
      this.report({ version: VERSION, state: "idle", writes: false, error });
    };
    if (!settings.serverEnabled) return idle("not serving: the server is turned off in the plugin settings");
    if (settings.tokens.length === 0) return idle("not serving: the plugin has no tokens");
    if (!settings.headlessEnabled) return idle("not serving: 'Serve while Obsidian is closed' is off in the plugin settings");
    try {
      await this.start(settings);
      this.lastError = "";
      this.retryAt = 0;
      this.report({ version: VERSION, state: "serving", writes: settings.headlessWrites });
      this.log(`serving ${settings.bundles.filter((b) => b.enabled).length} bundle(s) on http://127.0.0.1:${settings.port}/mcp/ (writes ${settings.headlessWrites ? "on" : "off"})`);
    } catch (e) {
      // Try again on the next tick: the port may be held by Obsidian before its lock appears.
      this.dataStamp = "";
      this.retryAt = Date.now() + RETRY_MS;
      idle(`could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async start(settings: PluginSettings): Promise<void> {
    const adapter = nodeStateAdapter(this.vault);
    const source = new VaultBundleSource(nodeVaultPort(this.vault), () => settings.bundles, { log: (m, e) => this.log(m, e) });
    const trust = new FileTrustLedger(adapter, this.stateRel);
    const flush = setInterval(() => void trust.flush(), 5_000);
    let server: OkfHttpServer | undefined;
    try {
      await source.reload();
      await trust.load();
      const service = new KnowledgeService(source, undefined, trust);
      const writes = settings.headlessWrites
        ? new WriteService(source, new NodeFilePort(this.vault), new FileSnapshotStore(adapter, `${this.stateRel}/snapshots`), new FileAuditLog(adapter, this.stateRel), {
            paused: () => settings.agentWritesPaused,
            perMinute: settings.writesPerMinute,
            perDay: settings.writesPerDay,
            log: (m, e) => this.log(m, e),
            trust,
            autoApprove: autoApproveRule(service, () => settings.autoApprove),
          })
        : undefined;
      // data.json belongs to the plugin; last-used times are not recorded while Obsidian is closed.
      const tokens = new TokenStore(() => settings.tokens, () => {});
      server = new OkfHttpServer({
        service,
        tokens,
        ...(writes ? { writes } : {}),
        version: VERSION,
        allowedOrigins: settings.allowedOrigins,
        instructionsNote: writes ? WRITABLE_NOTE : READ_ONLY_NOTE,
        log: (level, message, error) => this.log(`${level}: ${message}`, error),
        onUnexpectedClose: () => {
          this.log("the server stopped unexpectedly; restarting");
          void this.release().then(() => (this.dataStamp = ""));
        },
      });
      await server.start(settings.port);
      this.running = { server, source, trust, writes, flush };
    } catch (e) {
      clearInterval(flush);
      source.dispose();
      await server?.stop();
      throw e;
    }
  }

  /** Stop taking requests, let queued writes finish, then flush the trust ledger. */
  async release(): Promise<void> {
    const r = this.running;
    if (!r) return;
    this.running = null;
    await r.server.stop();
    await r.writes?.idle();
    clearInterval(r.flush);
    await r.trust.flush();
    r.source.dispose();
  }
}

export const SERVE_USAGE = `okf serve --vault <path> [--config-dir .obsidian]
    Serve the vault's OKF Wiki MCP server while Obsidian is closed, using the plugin's settings.
okf serve --install --vault <path> [--config-dir .obsidian]
    Windows: copy this CLI to %USERPROFILE%\\.okf-wiki and run it at logon (Task Scheduler).
okf serve --uninstall --vault <path>
    Windows: remove that logon task and stop the server.
okf serve --start --vault <path>
    Windows: run the installed logon task now.
okf serve --stop --vault <path>
    Stop the server running for this vault. An installed task starts it again at the next logon.
okf serve --status --vault <path>
    Print {"installed", "running", "version"} as JSON.
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function serveCommand(argv: string[]): Promise<number> {
  const vaultArg = arg(argv, "--vault");
  if (argv.includes("--help") || argv.includes("-h") || !vaultArg) {
    process[vaultArg ? "stdout" : "stderr"].write(SERVE_USAGE);
    return vaultArg ? 0 : 2;
  }
  const options: ServeOptions = { vault: resolve(vaultArg), configDir: arg(argv, "--config-dir") ?? ".obsidian" };
  if (!existsSync(join(options.vault, options.configDir))) {
    process.stderr.write(`not an Obsidian vault (no ${options.configDir} folder): ${options.vault}\n`);
    return 2;
  }
  try {
    if (argv.includes("--install")) return install(options);
    if (argv.includes("--uninstall")) return await uninstall(options);
    if (argv.includes("--start")) return await startTask(options);
    if (argv.includes("--stop")) return await stop(options);
    if (argv.includes("--status")) return await status(options);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  return runDaemon(options);
}

async function runDaemon(options: ServeOptions): Promise<number> {
  // Shared plugin code calls window.setTimeout (popout-window safe in Obsidian).
  (globalThis as { window?: unknown }).window ??= globalThis;
  const daemon = new Daemon(options);
  let pipe;
  try {
    pipe = await holdDaemonPipe(options.vault);
  } catch {
    process.stderr.write(`another okf serve already runs for ${options.vault}\n`);
    return 1;
  }
  daemon.log(`okf serve ${VERSION} started for ${options.vault}`);
  const timer = setInterval(() => void daemon.tick().catch((e) => daemon.log("error", e)), POLL_MS);
  await daemon.tick();
  return new Promise((done) => {
    const stop = () => {
      clearInterval(timer);
      void daemon.release().finally(() => {
        writeDaemon(daemon.stateAbs, { version: VERSION, state: "idle", writes: false, error: "stopped" });
        daemon.log("stopped");
        pipe.close();
        done(0);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** One task per vault, so two vaults can each have a daemon. */
export function taskName(vault: string): string {
  const id = createHash("sha256").update(resolve(vault).toLowerCase()).digest("hex").slice(0, 8);
  return `OKF Wiki ${basename(vault).replace(/[^\w .-]/g, "_")} ${id}`;
}

/** A PowerShell single-quoted string. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Run a script as one unit, so a throw stops it (a script read from stdin runs line by line). */
function powershell(script: string): void {
  // No progress records, and errors as one plain line, not CLIXML, when output is redirected.
  const wrapped = `$ProgressPreference = 'SilentlyContinue'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    // PowerShell has printed the reason; the default message would repeat the encoded script.
    throw new Error("the PowerShell step failed");
  }
}

function install(options: ServeOptions): number {
  if (process.platform !== "win32") throw new Error("--install supports Windows only. The user manual has a LaunchAgent (macOS) and a systemd unit (Linux).");
  const self = process.argv[1];
  if (!self || !self.endsWith(".cjs")) throw new Error("run --install from the built okf.cjs, not from source");
  // Not LOCALAPPDATA: Windows redirects writes there from packaged (MSIX) apps, such as a terminal
  // inside one, and the logon task then cannot find the copy (live install test, ADR 0009).
  const dir = join(homedir(), ".okf-wiki");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "okf.cjs");
  if (resolve(self).toLowerCase() !== script.toLowerCase()) copyFileSync(self, script);
  // conhost --headless runs node with no window (spike in ADR 0009).
  const args = `--headless "${process.execPath}" "${script}" serve --vault "${options.vault}" --config-dir "${options.configDir}"`;
  const name = taskName(options.vault);
  powershell(`$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psq(args)}
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName ${psq(name)} -Action $a -Trigger $t -Settings $s -Description 'OKF Wiki MCP server while Obsidian is closed' -Force | Out-Null
Start-ScheduledTask -TaskName ${psq(name)}
`);
  process.stdout.write(`installed and started the logon task '${name}'\n  ${script}\n  log: ${join(options.vault, options.configDir, "plugins", PLUGIN_ID, "state", "daemon.log")}\n`);
  return 0;
}

async function uninstall(options: ServeOptions): Promise<number> {
  if (process.platform !== "win32") throw new Error("--uninstall supports Windows only");
  const name = taskName(options.vault);
  powershell(`$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName ${psq(name)} -ErrorAction SilentlyContinue
if ($t) { Unregister-ScheduledTask -TaskName ${psq(name)} -Confirm:$false; 'removed the logon task' } else { 'no logon task for this vault' }
`);
  await stop(options);
  return 0;
}

/**
 * Stop the daemon that holds this vault's pipe. Ending its task stops conhost but not node.
 * On Windows this ends the process at once: writes in flight finish as whole files, but trust
 * ledger changes from the last few seconds may be lost.
 */
async function stop(options: ServeOptions): Promise<number> {
  const pid = readDaemon(join(options.vault, options.configDir, "plugins", PLUGIN_ID, "state"))?.pid;
  if (!pid || !(await daemonRunning(options.vault))) {
    process.stdout.write("okf serve is not running for this vault\n");
    return 0;
  }
  process.kill(pid);
  process.stdout.write(`stopped okf serve (pid ${pid})\n`);
  return 0;
}

/** One JSON line for the plugin's settings: is the task installed, does a daemon run, which version is this. */
async function status(options: ServeOptions): Promise<number> {
  let installed = false;
  if (process.platform === "win32") {
    try {
      const name = taskName(options.vault).replace(/'/g, "''");
      installed = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[bool](Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue)`], { encoding: "utf8", windowsHide: true }).trim() === "True";
    } catch {
      installed = false;
    }
  }
  process.stdout.write(`${JSON.stringify({ installed, running: await daemonRunning(options.vault), version: VERSION })}
`);
  return 0;
}

/** Run the installed logon task now. */
async function startTask(options: ServeOptions): Promise<number> {
  if (await daemonRunning(options.vault)) {
    process.stdout.write("okf serve already runs for this vault\n");
    return 0;
  }
  if (process.platform !== "win32") throw new Error("--start supports Windows only; elsewhere start your service manager's unit");
  const name = taskName(options.vault);
  powershell(`$ErrorActionPreference = 'Stop'
if (-not (Get-ScheduledTask -TaskName ${psq(name)} -ErrorAction SilentlyContinue)) { throw 'no logon task for this vault: run okf serve --install first' }
Start-ScheduledTask -TaskName ${psq(name)}
'started the logon task'
`);
  return 0;
}
