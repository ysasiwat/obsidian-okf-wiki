// Who serves the vault, the plugin or `okf serve` (ADR 0009). Both use the plugin's state
// folder: the plugin holds server.lock while it is loaded, the daemon reports in daemon.json
// and holds a named pipe (a Unix socket elsewhere) while it runs, which the OS releases when
// the process dies, so a stale daemon.json never looks alive.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const LOCK_FILE = "server.lock";
export const DAEMON_FILE = "daemon.json";
/** The plugin rewrites its lock this often; a lock older than LOCK_STALE_MS is ignored. */
export const LOCK_REFRESH_MS = 30_000;
export const LOCK_STALE_MS = 120_000;
export const RELEASE_TIMEOUT_MS = 10_000;

export interface PluginLock {
  pid: number;
  id: string;
  version: string;
  at: string;
}

export interface DaemonStatus {
  pid: number;
  version: string;
  /** serving: holds the port; released: a loaded plugin has it; idle: nothing to serve. */
  state: "serving" | "released" | "idle";
  writes: boolean;
  at: string;
  error?: string;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** `id` tells plugin instances apart: a reload starts the next one in the same process. */
export function writeLock(stateDir: string, version: string, id: string): void {
  const lock: PluginLock = { pid: process.pid, id, version, at: new Date().toISOString() };
  writeFileSync(join(stateDir, LOCK_FILE), JSON.stringify(lock));
}

/** Removes the lock only if this plugin instance wrote it. */
export function removeLock(stateDir: string, id: string): void {
  const path = join(stateDir, LOCK_FILE);
  if (readJson<PluginLock>(path)?.id === id) rmSync(path, { force: true });
}

/** A loaded plugin holds the vault: its lock exists, is fresh and its process lives. */
export function lockHeld(stateDir: string, now = Date.now()): boolean {
  const lock = readJson<PluginLock>(join(stateDir, LOCK_FILE));
  if (!lock || typeof lock.pid !== "number") return false;
  const age = now - Date.parse(lock.at);
  return !(age > LOCK_STALE_MS) && pidAlive(lock.pid);
}

export function readDaemon(stateDir: string): DaemonStatus | null {
  return readJson<DaemonStatus>(join(stateDir, DAEMON_FILE));
}

export function writeDaemon(stateDir: string, status: Omit<DaemonStatus, "pid" | "at">): void {
  writeFileSync(join(stateDir, DAEMON_FILE), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...status }));
}

/** The pipe that marks a running daemon for this vault. */
export function daemonPipe(vaultBase: string): string {
  const id = createHash("sha256").update(resolve(vaultBase).toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\okf-wiki-${id}` : join(tmpdir(), `okf-wiki-${id}.sock`);
}

/** Whether a daemon runs for this vault. */
export function daemonRunning(vaultBase: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(daemonPipe(vaultBase));
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/** Hold the daemon's pipe; rejects when another daemon already runs for this vault. */
export async function holdDaemonPipe(vaultBase: string): Promise<Server> {
  const path = daemonPipe(vaultBase);
  const listen = () =>
    new Promise<Server>((ok, fail) => {
      const server = createServer((s) => s.destroy());
      server.once("error", fail);
      server.listen(path, () => ok(server));
    });
  try {
    return await listen();
  } catch (e) {
    // A Unix socket file outlives a crashed process; Windows pipes do not.
    if (process.platform === "win32" || (e as { code?: string }).code !== "EADDRINUSE" || (await daemonRunning(vaultBase))) throw e;
    if (existsSync(path)) unlinkSync(path);
    return listen();
  }
}

/**
 * Plugin side: after writing the lock, wait until a serving daemon has released the vault.
 * "none" when no daemon was serving.
 */
export async function waitForRelease(
  stateDir: string,
  vaultBase: string,
  timeoutMs = RELEASE_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => window.setTimeout(r, ms)),
): Promise<"none" | "released" | "timeout"> {
  if (readDaemon(stateDir)?.state !== "serving" || !(await daemonRunning(vaultBase))) return "none";
  for (let waited = 0; waited < timeoutMs; waited += 200) {
    await sleep(200);
    if (readDaemon(stateDir)?.state !== "serving" || !(await daemonRunning(vaultBase))) return "released";
  }
  return "timeout";
}
