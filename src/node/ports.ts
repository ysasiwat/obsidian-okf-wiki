// The vault, file and state ports over Node's file system, for `okf serve` while Obsidian is
// closed (ADR 0009). Paths are vault-relative with "/", as Obsidian's are.

import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { etagOf } from "../core/write";
import { createDiskGuard } from "../obsidian/diskGuard";
import type { StateAdapter } from "../obsidian/stateStore";
import type { VaultChange, VaultPort } from "../obsidian/vaultBundleSource";
import { WriteConflict, type FilePort } from "../service/types";

/** Obsidian skips dot-files and dot-folders, which also hides the config folder and .trash. */
const hidden = (vaultPath: string): boolean => vaultPath.split("/").some((s) => s.startsWith("."));

export class NodeVault {
  readonly guard: (vaultPath: string) => boolean;

  constructor(readonly base: string, readonly configDir: string) {
    this.guard = createDiskGuard(base, configDir);
  }

  abs(vaultPath: string): string {
    return join(this.base, ...vaultPath.split("/").filter(Boolean));
  }

  /** Whether a path, or for a new file its nearest existing folder, is really inside the vault. */
  safeTarget(vaultPath: string): boolean {
    let p = vaultPath;
    while (p && !existsSync(this.abs(p))) p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    return this.guard(p);
  }
}

export function nodeVaultPort(vault: NodeVault): VaultPort {
  return {
    configDir: vault.configDir,
    listFiles: () => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(vault.abs(dir), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const p = dir ? `${dir}/${e.name}` : e.name;
          // Links count as what they point to; the guard decides later whether they are served.
          const isDir = e.isSymbolicLink() ? statSafe(vault.abs(p))?.isDirectory() : e.isDirectory();
          if (isDir) walk(p);
          else out.push(p);
        }
      };
      walk("");
      return out;
    },
    isFolder: (path) => statSafe(vault.abs(path))?.isDirectory() ?? false,
    readText: (path) => readFile(vault.abs(path), "utf8"),
    readHidden: async (path) => (existsSync(vault.abs(path)) ? readFile(vault.abs(path), "utf8") : null),
    isSafeOnDisk: vault.guard,
    onChange: (listener: (change: VaultChange) => void) => {
      // Recursive fs.watch works on Windows and macOS, and on Linux since Node 20. It reports a
      // name and no reliable kind, so the path's existence decides between modify and delete.
      const watcher = watch(vault.base, { recursive: true }, (_event, name) => {
        if (!name) return;
        const path = name.split(/[\\/]/).join("/");
        if (hidden(path)) return;
        listener({ kind: existsSync(vault.abs(path)) ? "modify" : "delete", path });
      });
      return () => watcher.close();
    },
  };
}

function statSafe(abs: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(abs);
  } catch {
    return undefined;
  }
}

/** Writes straight to disk. No editor exists here, so nobody can be typing in one. */
export class NodeFilePort implements FilePort {
  constructor(private readonly vault: NodeVault) {}

  private target(bundle: string, path: string): { vp: string; abs: string } {
    const vp = `${bundle}/${path}`;
    if (!this.vault.safeTarget(vp)) throw new Error(`${path} is not inside the vault on disk`);
    return { vp, abs: this.vault.abs(vp) };
  }

  async read(bundle: string, path: string): Promise<string | undefined> {
    const vp = `${bundle}/${path}`;
    const abs = this.vault.abs(vp);
    if (!existsSync(abs)) return undefined;
    if (!this.vault.guard(vp)) throw new Error(`${path} is not inside the vault on disk`);
    return readFile(abs, "utf8");
  }

  async write(bundle: string, path: string, text: string, expectedEtag: string | null): Promise<void> {
    const { abs } = this.target(bundle, path);
    const current = existsSync(abs) ? await readFile(abs, "utf8") : undefined;
    if (expectedEtag === null && current !== undefined) throw new WriteConflict(`${path} already exists`);
    if (expectedEtag !== null && current === undefined) throw new WriteConflict(`${path} no longer exists`);
    if (expectedEtag !== null && etagOf(current!) !== expectedEtag) throw new WriteConflict(`${path} changed on disk`);
    await mkdir(dirname(abs), { recursive: true });
    // A dot-name, so the watcher and Obsidian ignore it; the rename leaves no half-written file.
    const tmp = join(dirname(abs), `.${basename(abs)}.okf-tmp`);
    await writeFile(tmp, text, "utf8");
    await rename(tmp, abs);
  }

  async rename(bundle: string, from: string, to: string): Promise<void> {
    const src = this.target(bundle, from).abs;
    const dst = this.target(bundle, to).abs;
    if (!existsSync(src)) throw new WriteConflict(`${from} no longer exists`);
    if (existsSync(dst)) throw new WriteConflict(`${to} already exists`);
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
  }

  /** Obsidian's own trash folder in the vault, where "Move to Obsidian trash" puts files. */
  async trash(bundle: string, path: string): Promise<void> {
    const { abs } = this.target(bundle, path);
    if (!existsSync(abs)) return;
    const dir = this.vault.abs(".trash");
    await mkdir(dir, { recursive: true });
    let dst = join(dir, basename(abs));
    if (existsSync(dst)) dst = join(dir, `${Date.now()} ${basename(abs)}`);
    await rename(abs, dst);
  }

  msSinceHumanInput(): number | null {
    return null;
  }
}

/** Obsidian's DataAdapter, for the files in the plugin's state folder. */
export function nodeStateAdapter(vault: NodeVault): StateAdapter {
  const a = (p: string) => vault.abs(p);
  return {
    exists: async (p) => existsSync(a(p)),
    mkdir: async (p) => void (await mkdir(a(p), { recursive: true })),
    read: (p) => readFile(a(p), "utf8"),
    write: (p, data) => writeFile(a(p), data, "utf8"),
    append: (p, data) => appendFile(a(p), data, "utf8"),
    remove: (p) => rm(a(p), { force: true }),
    rename: (from, to) => rename(a(from), a(to)),
    list: async (p) => {
      const entries = await readdir(a(p), { withFileTypes: true });
      return {
        files: entries.filter((e) => e.isFile()).map((e) => `${p}/${e.name}`),
        folders: entries.filter((e) => e.isDirectory()).map((e) => `${p}/${e.name}`),
      };
    },
    stat: async (p) => {
      try {
        return { size: (await stat(a(p))).size };
      } catch {
        return null;
      }
    },
  };
}
