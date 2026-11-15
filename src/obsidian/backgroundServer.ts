// Install, start, stop and remove okf serve from the settings (ADR 0009). Windows only. The
// plugin writes the embedded daemon to %USERPROFILE%\.okf-wiki\okf.cjs and runs it with Node,
// so the task logic stays in one place (src/cli/serve.ts).

import { Platform } from "obsidian";

/** The daemon bundle, defined by esbuild.config.mjs; absent in tests and dev type checks. */
declare const __OKF_DAEMON_SOURCE__: string | undefined;

export const MIN_NODE_MAJOR = 22;

export interface BackgroundState {
  /** Why the buttons cannot be used, if they cannot. */
  unavailable?: string;
  installed: boolean;
  running: boolean;
  /** Version of the installed okf.cjs, or null when there is none. */
  version: string | null;
}

export type BackgroundAction = "install" | "start" | "stop" | "uninstall";

type ExecFile = (file: string, args: string[], options: { windowsHide: boolean; timeout: number }) => Promise<{ stdout: string; stderr: string }>;

async function nodeApi(): Promise<{ exec: ExecFile; fs: typeof import("node:fs"); path: typeof import("node:path"); home: string }> {
  // Loaded on demand and only on Windows desktop: the plugin must not need these elsewhere.
  // require, not import(): esbuild keeps import() of an external as is, and Obsidian's renderer
  // then fetches "node:child_process" as a URL and fails (live test, 2026-11-16).
  /* eslint-disable @typescript-eslint/no-require-imports -- import() breaks in the renderer, see above */
  const cp = require("node:child_process") as typeof import("node:child_process");
  const util = require("node:util") as typeof import("node:util");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  /* eslint-enable @typescript-eslint/no-require-imports -- only these lines need require */
  await Promise.resolve();
  return { exec: util.promisify(cp.execFile) as unknown as ExecFile, fs, path, home: os.homedir() };
}

export class BackgroundServer {
  private node: string | null | undefined;

  constructor(
    private readonly vault: string,
    private readonly configDir: string,
  ) {}

  static supported(): boolean {
    return Platform.isDesktopApp && Platform.isWin;
  }

  static embedded(): string | null {
    return typeof __OKF_DAEMON_SOURCE__ === "string" ? __OKF_DAEMON_SOURCE__ : null;
  }

  private async script(): Promise<string> {
    const { path, home } = await nodeApi();
    return path.join(home, ".okf-wiki", "okf.cjs");
  }

  /** Why no usable Node was found, for the status line. */
  nodeProblem = "";

  /**
   * node.exe at version MIN_NODE_MAJOR or later: from PATH, else the installer's usual folders
   * (Obsidian started from a shortcut can have an older PATH than a new terminal). Null if none.
   */
  async findNode(): Promise<string | null> {
    // Only a found Node is remembered, so "Check again" sees one installed since.
    if (this.node) return this.node;
    this.nodeProblem = "";
    const { exec, fs, path } = await nodeApi();
    const candidates: string[] = [];
    try {
      const out = (await exec("where.exe", ["node"], { windowsHide: true, timeout: 10_000 })).stdout;
      candidates.push(...out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    } catch (e) {
      this.nodeProblem = `node is not on PATH (${(e as Error).message.split(/\r?\n/)[0]})`;
    }
    for (const base of [process.env["ProgramFiles"], process.env["LOCALAPPDATA"] && path.join(process.env["LOCALAPPDATA"], "Programs")]) {
      if (base) candidates.push(path.join(base, "nodejs", "node.exe"));
    }
    for (const c of [...new Set(candidates)]) {
      if (!fs.existsSync(c)) continue;
      try {
        const version = (await exec(c, ["--version"], { windowsHide: true, timeout: 10_000 })).stdout.trim();
        if (Number(/^v(\d+)/.exec(version)?.[1] ?? 0) >= MIN_NODE_MAJOR) return (this.node = c);
        this.nodeProblem = `${c} is ${version}`;
      } catch (e) {
        this.nodeProblem = `${c} did not run (${(e as Error).message.split(/\r?\n/)[0]})`;
      }
    }
    console.warn("[okf-wiki] no usable Node.js:", this.nodeProblem || "none found");
    // Also in the state folder, where the owner (or a helper) can read it without the console.
    try {
      const file = path.join(this.vault, this.configDir, "plugins", "okf-wiki", "state", "node-check.log");
      fs.appendFileSync(file, `${new Date().toISOString()} candidates=${JSON.stringify(candidates)} problem=${this.nodeProblem || "none found"}\n`);
    } catch {
      // Diagnostics only.
    }
    return (this.node = null);
  }

  private async run(args: string[]): Promise<string> {
    const node = await this.findNode();
    if (!node) throw new Error(`Node.js ${MIN_NODE_MAJOR} or later is not installed`);
    const { exec } = await nodeApi();
    try {
      const out = await exec(node, [await this.script(), "serve", ...args, "--vault", this.vault, "--config-dir", this.configDir], { windowsHide: true, timeout: 60_000 });
      return out.stdout;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error((err.stderr ?? "").trim().split(/\r?\n/)[0] || err.message || String(e));
    }
  }

  async state(): Promise<BackgroundState> {
    if (!(await this.findNode())) return { unavailable: `Requires Node.js ${MIN_NODE_MAJOR} or later${this.nodeProblem ? `: ${this.nodeProblem}` : ""}.`, installed: false, running: false, version: null };
    const { fs } = await nodeApi();
    if (!fs.existsSync(await this.script())) return { installed: false, running: false, version: null };
    try {
      const s = JSON.parse(await this.run(["--status"])) as { installed: boolean; running: boolean; version: string };
      return { installed: s.installed, running: s.running, version: s.version };
    } catch {
      return { installed: false, running: false, version: null };
    }
  }

  /** Write the embedded daemon where the logon task runs it. */
  async writeScript(): Promise<void> {
    const source = BackgroundServer.embedded();
    if (!source) throw new Error("this build of the plugin does not include the background server");
    const { fs, path } = await nodeApi();
    const file = await this.script();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }

  async act(action: BackgroundAction): Promise<string> {
    if (action === "install") await this.writeScript();
    return (await this.run([`--${action}`])).trim();
  }

  /**
   * After a plugin update: give the installed task the matching daemon and restart it.
   * Returns the new version when it updated, null when nothing needed doing.
   */
  async updateIfStale(version: string): Promise<string | null> {
    if (!BackgroundServer.embedded()) return null;
    const s = await this.state();
    if (!s.installed || s.version === version) return null;
    await this.writeScript();
    if (s.running) await this.run(["--stop"]);
    await this.run(["--start"]);
    return version;
  }
}
