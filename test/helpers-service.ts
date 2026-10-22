import { analyzeBundle } from "../src/core/bundle";
import { etagOf } from "../src/core/write";
import {
  WriteConflict,
  type AuditEntry, type AuditLog, type BundleHandle, type BundleProvider, type CommitRecord,
  type FilePort, type Principal, type Scope, type SnapshotStore,
} from "../src/service/types";
import { loadFixtureBundle } from "./helpers";

/** A provider over in-memory bundles whose versions bump on every change. */
export class MemoryProvider implements BundleProvider {
  private handles = new Map<string, BundleHandle>();
  readonly files = new Map<string, Map<string, string>>();
  isReady = true;

  set(name: string, files: Map<string, string>): this {
    this.files.set(name, new Map(files));
    this.rebuild(name);
    return this;
  }

  rebuild(name: string): void {
    const prev = this.handles.get(name);
    this.handles.set(name, { name, model: analyzeBundle(new Map(this.files.get(name)!), prev?.model), version: (prev?.version ?? 0) + 1 });
  }

  bundles(): BundleHandle[] {
    return [...this.handles.values()];
  }

  ready(): boolean {
    return this.isReady;
  }

  applyLocal(bundle: string, changes: ReadonlyMap<string, string | null>): void {
    const f = this.files.get(bundle)!;
    for (const [p, t] of changes) {
      if (t === null) f.delete(p);
      else f.set(p, t);
    }
    this.rebuild(bundle);
  }
}

/** File access over the provider's maps, with etag checks like the real writer. */
export class MemoryFilePort implements FilePort {
  typing = new Map<string, number>();
  trashed: string[] = [];
  /** Simulate someone else changing a file right before the write lands. */
  interfere: ((bundle: string, path: string) => void) | null = null;

  constructor(private readonly provider: MemoryProvider, private readonly now: () => number = Date.now) {}

  private map(bundle: string): Map<string, string> {
    return this.provider.files.get(bundle)!;
  }

  async read(bundle: string, path: string): Promise<string | undefined> {
    return this.map(bundle).get(path);
  }

  async write(bundle: string, path: string, text: string, expectedEtag: string | null): Promise<void> {
    this.interfere?.(bundle, path);
    const current = this.map(bundle).get(path);
    if (expectedEtag === null ? current !== undefined : current === undefined || etagOf(current) !== expectedEtag) {
      throw new WriteConflict(`${path} changed`);
    }
    this.map(bundle).set(path, text);
  }

  async rename(bundle: string, from: string, to: string): Promise<void> {
    const m = this.map(bundle);
    const t = m.get(from);
    if (t === undefined) throw new WriteConflict(`${from} is gone`);
    if (m.has(to)) throw new WriteConflict(`${to} exists`);
    m.delete(from);
    m.set(to, t);
  }

  async trash(bundle: string, path: string): Promise<void> {
    this.map(bundle).delete(path);
    this.trashed.push(path);
  }

  msSinceHumanInput(bundle: string, path: string): number | null {
    const t = this.typing.get(`${bundle}/${path}`);
    return t === undefined ? null : this.now() - t;
  }
}

export class MemorySnapshots implements SnapshotStore {
  records: CommitRecord[] = [];
  async save(r: CommitRecord): Promise<void> {
    this.records.unshift(r);
  }
  async discard(id: string): Promise<void> {
    this.records = this.records.filter((r) => r.id !== id);
  }
  async get(id: string): Promise<CommitRecord | undefined> {
    return this.records.find((r) => r.id === id);
  }
  async list(limit: number): Promise<CommitRecord[]> {
    return this.records.slice(0, limit);
  }
}

export class MemoryAudit implements AuditLog {
  entries: AuditEntry[] = [];
  async append(e: AuditEntry): Promise<void> {
    this.entries.push(e);
  }
}

export function fixtureProvider(...names: string[]): MemoryProvider {
  const p = new MemoryProvider();
  for (const n of names) p.set(n, loadFixtureBundle(n));
  return p;
}

export function principal(over: Partial<Principal> = {}): Principal {
  return {
    tokenName: "test",
    kind: "agent",
    scopes: new Set<Scope>(["read"]),
    bundles: "*",
    pathPrefixes: [],
    ...over,
  };
}
