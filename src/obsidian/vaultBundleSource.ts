// Keeps an in-memory copy of every enabled bundle's files and a BundleModel built from
// them, refreshed from vault events. Depends on VaultPort, not on obsidian, so it is
// tested in Node; src/main.ts adapts Obsidian's Vault to the port.

import { analyzeBundle, analyzeBundleSliced, isHiddenPath } from "../core/bundle";
import { parseConcept } from "../core/document";
import { POLICY_FILENAME } from "../core/policy";
import type { BundleHandle, BundleProvider } from "../service/types";

export interface VaultChange {
  kind: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
}

/** The slice of Obsidian's vault this layer needs. Paths are vault-relative with "/". */
export interface VaultPort {
  configDir: string;
  /** Every file Obsidian indexes (dot-files and dot-folders excluded by Obsidian). */
  listFiles(): string[];
  isFolder(path: string): boolean;
  readText(path: string): Promise<string>;
  /** Read a file Obsidian does not index, such as `.okf.yaml`; null when absent. */
  readHidden(path: string): Promise<string | null>;
  /** False for files whose real location is outside the vault or in the config dir. */
  isSafeOnDisk(path: string): boolean;
  onChange(listener: (change: VaultChange) => void): () => void;
}

export interface BundleSetting {
  path: string;
  enabled: boolean;
}

/** Problems with registering `path` as a bundle, given the bundles already registered. */
export function bundlePathErrors(path: string, existing: readonly string[], port: Pick<VaultPort, "configDir" | "isFolder">): string[] {
  const p = path.trim().replace(/^\/+|\/+$/g, "");
  if (p === "") return ["Choose a folder; the vault root cannot be a bundle."];
  if (/[\\:\0]/.test(p) || p.split("/").some((s) => s === "." || s === "..")) return ["Use a plain vault-relative folder path."];
  if (isHiddenPath(p) || p === port.configDir || p.startsWith(`${port.configDir}/`)) return ["Hidden folders and the configuration folder cannot be bundles."];
  if (!port.isFolder(p)) return [`'${p}' is not a folder in this vault.`];
  for (const e of existing) {
    if (e === p) return [`'${p}' is already a bundle.`];
    if (p.startsWith(`${e}/`) || e.startsWith(`${p}/`)) return [`Bundles cannot be nested: '${p}' and '${e}'.`];
  }
  return [];
}

interface BundleState {
  path: string;
  files: Map<string, string>;
  handle: BundleHandle | null;
  /** The last .okf.yaml read, for synchronous rebuilds after our own writes. */
  policy: string | null;
  /** Counts rebuilds, so a sliced first load that finishes late never replaces a newer model. */
  rebuilds: number;
}

export class VaultBundleSource implements BundleProvider {
  private states = new Map<string, BundleState>();
  private version = 0;
  private isReady = false;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Bumped per path on every change, so a slow read never overwrites a newer one. */
  private generation = new Map<string, number>();

  constructor(
    private readonly port: VaultPort,
    private readonly settings: () => readonly BundleSetting[],
    private readonly options: {
      debounceMs?: number;
      log?: (message: string, error?: unknown) => void;
      onUpdate?: () => void;
      /** Resumes a sliced first load on a later tick; default setTimeout(0). */
      pause?: () => Promise<void>;
    } = {},
  ) {}

  bundles(): BundleHandle[] {
    return [...this.states.values()].map((s) => s.handle).filter((h): h is BundleHandle => h !== null);
  }

  ready(): boolean {
    return this.isReady;
  }

  /** Load every enabled bundle from scratch and start following vault changes. */
  async reload(): Promise<void> {
    this.unsubscribe ??= this.port.onChange((c) => this.onChange(c));
    const enabled = this.settings().filter((b) => b.enabled).map((b) => b.path);
    for (const path of [...this.states.keys()]) if (!enabled.includes(path)) this.states.delete(path);
    for (const path of enabled) {
      // An already loaded bundle keeps its model while reloading and lends it as the previous
      // model, so unchanged files are not parsed again.
      const state: BundleState = { path, files: new Map(), handle: this.states.get(path)?.handle ?? null, policy: null, rebuilds: 0 };
      const prefix = `${path}/`;
      await Promise.all(
        this.port.listFiles()
          .filter((f) => f.startsWith(prefix))
          .map(async (f) => {
            const text = await this.load(f);
            if (text !== null) state.files.set(f.slice(prefix.length), text);
          }),
      );
      this.states.set(path, state);
      await this.rebuild(state);
    }
    this.isReady = true;
    this.options.onUpdate?.();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Folders that look like OKF bundles but are not registered yet. */
  async discover(): Promise<string[]> {
    const registered = this.settings().map((b) => b.path);
    const found: string[] = [];
    for (const f of this.port.listFiles()) {
      if (!f.endsWith("/index.md")) continue;
      const dir = f.slice(0, -"/index.md".length);
      if (registered.some((r) => dir === r || dir.startsWith(`${r}/`) || r.startsWith(`${dir}/`))) continue;
      if (found.some((x) => dir.startsWith(`${x}/`))) continue;
      let declared = (await this.port.readHidden(`${dir}/${POLICY_FILENAME}`)) !== null;
      if (!declared) {
        try {
          declared = parseConcept(await this.port.readText(f)).frontmatter["okf_version"] !== undefined;
        } catch {
          declared = false;
        }
      }
      if (declared) found.push(dir);
    }
    return found.sort();
  }

  async readText(bundle: string, path: string): Promise<string | null> {
    if (!this.states.has(bundle)) return null;
    const vaultPath = `${bundle}/${path}`;
    // Checked again here: a symlink may have changed since the bundle was loaded.
    if (!this.port.isSafeOnDisk(vaultPath)) return null;
    try {
      return await this.port.readText(vaultPath);
    } catch {
      return null;
    }
  }

  private async load(vaultPath: string): Promise<string | null> {
    if (!this.port.isSafeOnDisk(vaultPath)) {
      this.options.log?.(`skipped '${vaultPath}': its real location is outside the vault or in the configuration folder`);
      return null;
    }
    if (!vaultPath.endsWith(".md")) return "";
    try {
      return await this.port.readText(vaultPath);
    } catch (e) {
      this.options.log?.(`could not read '${vaultPath}'`, e);
      return null;
    }
  }

  private bundleOf(vaultPath: string): BundleState | undefined {
    for (const s of this.states.values()) if (vaultPath.startsWith(`${s.path}/`)) return s;
    return undefined;
  }

  private onChange(change: VaultChange): void {
    const touched = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
    for (const p of touched) this.generation.set(p, (this.generation.get(p) ?? 0) + 1);
    if (change.oldPath) this.remove(change.oldPath);
    if (change.kind === "delete") this.remove(change.path);
    else void this.update(change.path);
  }

  private remove(vaultPath: string): void {
    const s = this.bundleOf(vaultPath);
    if (!s) return;
    // A deleted folder arrives as one event for the folder itself.
    const rel = vaultPath.slice(s.path.length + 1);
    for (const k of [...s.files.keys()]) if (k === rel || k.startsWith(`${rel}/`)) s.files.delete(k);
    this.schedule(s.path);
  }

  private async update(vaultPath: string): Promise<void> {
    const s = this.bundleOf(vaultPath);
    if (!s) return;
    if (this.port.isFolder(vaultPath)) {
      // A created or renamed folder: load the files now inside it.
      for (const f of this.port.listFiles().filter((x) => x.startsWith(`${vaultPath}/`))) await this.update(f);
      return;
    }
    const gen = this.generation.get(vaultPath) ?? 0;
    const text = await this.load(vaultPath);
    if ((this.generation.get(vaultPath) ?? 0) !== gen) return; // a newer change will handle it
    const rel = vaultPath.slice(s.path.length + 1);
    if (text === null) s.files.delete(rel);
    else s.files.set(rel, text);
    this.schedule(s.path);
  }

  private schedule(bundlePath: string): void {
    this.pending.add(bundlePath);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.options.debounceMs ?? 300);
  }

  /** Rebuild models for bundles with pending changes now. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const paths = [...this.pending];
    this.pending.clear();
    for (const p of paths) {
      const s = this.states.get(p);
      if (s) await this.rebuild(s);
    }
    if (paths.length > 0) this.options.onUpdate?.();
  }

  private async rebuild(state: BundleState): Promise<void> {
    // The policy file is a dot-file Obsidian does not index or report changes for.
    state.policy = await this.port.readHidden(`${state.path}/${POLICY_FILENAME}`);
    if (state.handle) return this.rebuildNow(state);
    // First load: every file is parsed, so do it in slices and keep Obsidian responsive.
    const run = ++state.rebuilds;
    try {
      const model = await analyzeBundleSliced(this.snapshot(state), undefined, this.options.pause ?? (() => new Promise((r) => setTimeout(r, 0))));
      if (run === state.rebuilds) state.handle = { name: state.path, model, version: ++this.version };
    } catch (e) {
      this.options.log?.(`could not analyze bundle '${state.path}'`, e);
    }
  }

  private rebuildNow(state: BundleState): void {
    state.rebuilds++;
    try {
      state.handle = { name: state.path, model: analyzeBundle(this.snapshot(state), state.handle?.model), version: ++this.version };
    } catch (e) {
      this.options.log?.(`could not analyze bundle '${state.path}'`, e);
    }
  }

  private snapshot(state: BundleState): Map<string, string> {
    const files = new Map(state.files);
    if (state.policy !== null) files.set(POLICY_FILENAME, state.policy);
    return files;
  }

  /**
   * Files this plugin just wrote: update the model now rather than after the vault events.
   * The events still arrive and re-read the same text, which changes nothing.
   */
  applyLocal(bundle: string, changes: ReadonlyMap<string, string | null>): void {
    const state = this.states.get(bundle);
    if (!state) return;
    for (const [path, text] of changes) {
      if (text === null) state.files.delete(path);
      else state.files.set(path, path.endsWith(".md") ? text : "");
    }
    this.rebuildNow(state);
    this.options.onUpdate?.();
  }
}
