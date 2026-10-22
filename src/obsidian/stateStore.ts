// Snapshots and the audit log, kept in the plugin's state folder (DESIGN.md §6.7):
// device-local working data, not bundle content; settings suggest gitignoring it.

import type { AuditEntry, AuditLog, CommitRecord, SnapshotStore, TrustLedger } from "../service/types";

/** The DataAdapter methods used here, so the store is testable without Obsidian. */
export interface StateAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number } | null>;
}

export const SNAPSHOT_DAYS = 7;
export const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

interface IndexEntry {
  at: string;
  size: number;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(
    private readonly adapter: StateAdapter,
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid commit id ${id}`);
    return `${this.dir}/${id}.json`;
  }

  /**
   * When and how big each snapshot is, kept in memory and in one file next to the folder. Pruning
   * used to stat and read every snapshot on every write: about 300 ms per write with 166 snapshots
   * on a synced vault, growing with each one. The file is a cache: loading reconciles it with the
   * folder, reading only snapshots it does not know, so a stale or missing file is harmless.
   */
  private index: Promise<Map<string, IndexEntry>> | null = null;

  private get indexFile(): string {
    return `${this.dir}.index.json`;
  }

  private loadIndex(): Promise<Map<string, IndexEntry>> {
    this.index ??= (async () => {
      const index = new Map<string, IndexEntry>();
      const stored = await this.readIndexFile();
      if (!(await this.adapter.exists(this.dir))) return index;
      const { files } = await this.adapter.list(this.dir);
      let changed = false;
      // Only names this store writes; anything else in the folder is left alone.
      for (const f of files.filter((x) => /\/[A-Za-z0-9_-]+\.json$/.test(x))) {
        const id = f.slice(f.lastIndexOf("/") + 1, -".json".length);
        const known = stored.get(id);
        if (known) {
          index.set(id, known);
          continue;
        }
        changed = true;
        const size = (await this.adapter.stat(f))?.size ?? 0;
        let at = "";
        try {
          at = (JSON.parse(await this.adapter.read(f)) as CommitRecord).at;
        } catch {
          at = "";
        }
        index.set(id, { at, size });
      }
      if (changed || stored.size !== index.size) await this.writeIndexFile(index);
      return index;
    })();
    return this.index;
  }

  private async readIndexFile(): Promise<Map<string, IndexEntry>> {
    const out = new Map<string, IndexEntry>();
    try {
      if (!(await this.adapter.exists(this.indexFile))) return out;
      const data = JSON.parse(await this.adapter.read(this.indexFile)) as Record<string, unknown>;
      for (const [id, e] of Object.entries(data)) {
        const entry = e as Partial<IndexEntry> | null;
        if (typeof entry?.at === "string" && typeof entry.size === "number") out.set(id, { at: entry.at, size: entry.size });
      }
    } catch {
      // A damaged index is rebuilt from the folder.
    }
    return out;
  }

  private async writeIndexFile(index: Map<string, IndexEntry>): Promise<void> {
    try {
      await this.adapter.write(this.indexFile, JSON.stringify(Object.fromEntries(index)));
    } catch {
      // Only a cache: the next session reconciles it with the folder.
    }
  }

  async save(record: CommitRecord): Promise<void> {
    const index = await this.loadIndex();
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    const json = JSON.stringify(record);
    await this.adapter.write(this.file(record.id), json);
    index.set(record.id, { at: record.at, size: new TextEncoder().encode(json).length });
    await this.prune(index);
    await this.writeIndexFile(index);
  }

  async discard(id: string): Promise<void> {
    const f = this.file(id);
    if (await this.adapter.exists(f)) await this.adapter.remove(f);
    const index = await this.loadIndex();
    if (index.delete(id)) await this.writeIndexFile(index);
  }

  async get(id: string): Promise<CommitRecord | undefined> {
    let f: string;
    try {
      f = this.file(id);
    } catch {
      return undefined;
    }
    if (!(await this.adapter.exists(f))) return undefined;
    return JSON.parse(await this.adapter.read(f)) as CommitRecord;
  }

  async list(limit: number): Promise<CommitRecord[]> {
    const records = await this.all();
    return records.slice(0, limit);
  }

  private async all(): Promise<CommitRecord[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const { files } = await this.adapter.list(this.dir);
    const out: CommitRecord[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        out.push(JSON.parse(await this.adapter.read(f)) as CommitRecord);
      } catch {
        // A damaged snapshot is skipped rather than blocking the others.
      }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  /** Drop snapshots older than 7 days, then the oldest until the total fits 50 MB. Reads only the index. */
  private async prune(index: Map<string, { at: string; size: number }>): Promise<void> {
    const entries = [...index].sort(([, a], [, b]) => (a.at < b.at ? -1 : 1));
    const cutoff = new Date(this.now() - SNAPSHOT_DAYS * 86_400_000).toISOString();
    let total = entries.reduce((sum, [, e]) => sum + e.size, 0);
    for (const [id, e] of entries) {
      if (e.at >= cutoff && total <= SNAPSHOT_MAX_BYTES) break;
      const f = this.file(id);
      if (await this.adapter.exists(f)) await this.adapter.remove(f);
      index.delete(id);
      total -= e.size;
    }
  }
}

export class FileAuditLog implements AuditLog {
  constructor(
    private readonly adapter: StateAdapter,
    private readonly dir: string,
  ) {}

  private queue: Promise<void> = Promise.resolve();

  /** Appends run one after another: two bundles writing at once must not both rotate the file. */
  append(entry: AuditEntry): Promise<void> {
    const run = this.queue.then(() => this.write(entry));
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(entry: AuditEntry): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    const path = `${this.dir}/audit.jsonl`;
    const size = (await this.adapter.stat(path))?.size ?? 0;
    if (size > AUDIT_ROTATE_BYTES) {
      const old = `${this.dir}/audit.1.jsonl`;
      if (await this.adapter.exists(old)) await this.adapter.remove(old);
      await this.adapter.rename(path, old);
    }
    await this.adapter.append(path, `${JSON.stringify(entry)}\n`);
  }
}

/** The trust snapshot in state/trust.json, kept in memory and flushed when changed. */
export class FileTrustLedger implements TrustLedger {
  private map = new Map<string, string>();
  private dirty = false;

  constructor(private readonly adapter: StateAdapter, private readonly dir: string) {}

  private get file(): string {
    return `${this.dir}/trust.json`;
  }

  async load(): Promise<void> {
    if (!(await this.adapter.exists(this.file))) return;
    try {
      this.map = new Map(Object.entries(JSON.parse(await this.adapter.read(this.file)) as Record<string, string>));
    } catch {
      // A damaged snapshot means "unknown" for every concept, which is the safe reading.
      this.map = new Map();
    }
  }

  get(bundle: string, path: string): string | undefined {
    return this.map.get(`${bundle}/${path}`);
  }

  set(bundle: string, path: string, fingerprint: string | null): void {
    const key = `${bundle}/${path}`;
    if (fingerprint === null) this.map.delete(key);
    else this.map.set(key, fingerprint);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    await this.adapter.write(this.file, JSON.stringify(Object.fromEntries(this.map)));
  }
}
