import { describe, expect, it } from "vitest";
import { humanActor, sanitizeSettings } from "../../src/obsidian/settings";
import { AUDIT_ROTATE_BYTES, FileAuditLog, FileSnapshotStore, FileTrustLedger, type StateAdapter } from "../../src/obsidian/stateStore";
import { isHumanUserEvent } from "../../src/obsidian/userEvents";
import { VaultBundleSource, type VaultChange, type VaultPort } from "../../src/obsidian/vaultBundleSource";
import type { CommitRecord } from "../../src/service/types";

class MemoryAdapter implements StateAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async read(p: string) { const t = this.files.get(p); if (t === undefined) throw new Error(`missing ${p}`); return t; }
  async write(p: string, d: string) { this.files.set(p, d); }
  async append(p: string, d: string) { this.files.set(p, (this.files.get(p) ?? "") + d); }
  async remove(p: string) { this.files.delete(p); }
  async rename(a: string, b: string) { this.files.set(b, this.files.get(a)!); this.files.delete(a); }
  async list(p: string) { return { files: [...this.files.keys()].filter((f) => f.startsWith(`${p}/`)), folders: [] }; }
  async stat(p: string) { const t = this.files.get(p); return t === undefined ? null : { size: t.length }; }
}

const record = (id: string, at: string, size = 10): CommitRecord => ({
  id, at, bundle: "K", actor: "a/1", token: "t", tool: "okf_update", conceptId: "c", files: [{ path: "c.md", before: "x".repeat(size), after: "y" }],
});

describe("FileSnapshotStore", () => {
  it("saves, lists newest first, gets and discards", async () => {
    const a = new MemoryAdapter();
    const store = new FileSnapshotStore(a, "state/snapshots", () => Date.parse("2026-10-19T00:00:00Z"));
    await store.save(record("c1", "2026-10-18T00:00:00Z"));
    await store.save(record("c2", "2026-10-18T12:00:00Z"));
    expect((await store.list(10)).map((r) => r.id)).toEqual(["c2", "c1"]);
    expect((await store.get("c1"))?.files[0]?.before).toBe("xxxxxxxxxx");
    await store.discard("c1");
    expect(await store.get("c1")).toBeUndefined();
    expect(await store.get("../escape")).toBeUndefined();
  });

  it("prunes snapshots older than 7 days", async () => {
    const a = new MemoryAdapter();
    const store = new FileSnapshotStore(a, "s", () => Date.parse("2026-10-19T00:00:00Z"));
    await store.save(record("old", "2026-10-01T00:00:00Z"));
    await store.save(record("new", "2026-10-18T00:00:00Z"));
    expect((await store.list(10)).map((r) => r.id)).toEqual(["new"]);
  });

  it("reads the folder once per session, not on every save, and still prunes what it finds", async () => {
    const a = new MemoryAdapter();
    const now = () => Date.parse("2026-10-19T00:00:00Z");
    await new FileSnapshotStore(a, "s", now).save(record("old", "2026-10-01T00:00:00Z"));
    a.files.set("s/notes.txt.json", "not a snapshot");
    let reads = 0;
    const read = a.read.bind(a);
    a.read = async (p: string) => (reads++, read(p));
    const store = new FileSnapshotStore(a, "s", now);
    await store.save(record("n1", "2026-10-18T00:00:00Z"));
    const afterFirst = reads;
    for (let i = 2; i <= 5; i++) await store.save(record(`n${i}`, "2026-10-18T00:00:00Z"));
    expect(reads).toBe(afterFirst);
    expect(a.files.has("s/old.json")).toBe(false);
    expect(a.files.has("s/notes.txt.json")).toBe(true);
    await store.discard("n5");
    expect((await store.list(10)).map((r) => r.id).sort()).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("starts the next session from its index file, reading only snapshots the file does not know", async () => {
    const a = new MemoryAdapter();
    const now = () => Date.parse("2026-10-19T00:00:00Z");
    const first = new FileSnapshotStore(a, "s", now);
    for (const id of ["k1", "k2", "k3"]) await first.save(record(id, "2026-10-18T00:00:00Z"));
    expect(Object.keys(JSON.parse(a.files.get("s.index.json")!)).sort()).toEqual(["k1", "k2", "k3"]);

    // Meanwhile, outside this session: one snapshot vanished, one arrived that the file does not list.
    a.files.delete("s/k2.json");
    a.files.set("s/k4.json", JSON.stringify(record("k4", "2026-10-01T00:00:00Z")));
    const read: string[] = [];
    const realRead = a.read.bind(a);
    a.read = async (p: string) => (read.push(p), realRead(p));
    const next = new FileSnapshotStore(a, "s", now);
    await next.save(record("k5", "2026-10-18T00:00:00Z"));
    expect(read.sort()).toEqual(["s.index.json", "s/k4.json"]);
    // k4 is older than 7 days and was pruned; k2 is gone from the index too.
    expect(Object.keys(JSON.parse(a.files.get("s.index.json")!)).sort()).toEqual(["k1", "k3", "k5"]);
    expect(a.files.has("s/k4.json")).toBe(false);

    a.files.set("s.index.json", "{ damaged");
    const rebuilt = new FileSnapshotStore(a, "s", now);
    await rebuilt.save(record("k6", "2026-10-18T00:00:00Z"));
    expect(Object.keys(JSON.parse(a.files.get("s.index.json")!)).sort()).toEqual(["k1", "k3", "k5", "k6"]);
  });
});

describe("FileAuditLog", () => {
  it("appends JSON lines and rotates at the size limit", async () => {
    const a = new MemoryAdapter();
    const log = new FileAuditLog(a, "state");
    const entry = { at: "t", token: "x", actor: "x/1", tool: "okf_create", bundle: "K", concept_id: "c", outcome: "written" as const };
    await log.append(entry);
    expect(a.files.get("state/audit.jsonl")!.trim().split("\n")).toHaveLength(1);
    a.files.set("state/audit.jsonl", "x".repeat(AUDIT_ROTATE_BYTES + 1));
    await log.append(entry);
    expect(a.files.has("state/audit.1.jsonl")).toBe(true);
    expect(a.files.get("state/audit.jsonl")!.trim().split("\n")).toHaveLength(1);
  });

  it("runs appends one after another, so concurrent ones rotate once and keep every line", async () => {
    const a = new MemoryAdapter();
    const log = new FileAuditLog(a, "state");
    a.files.set("state/audit.jsonl", "x".repeat(AUDIT_ROTATE_BYTES + 1));
    const entry = { at: "t", token: "x", actor: "x/1", tool: "okf_create", bundle: "K", concept_id: "c", outcome: "written" as const };
    await Promise.all([log.append(entry), log.append(entry), log.append(entry)]);
    expect(a.files.get("state/audit.1.jsonl")).toMatch(/^x+$/);
    expect(a.files.get("state/audit.jsonl")!.trim().split("\n")).toHaveLength(3);
  });
});

describe("isHumanUserEvent (ADR 0003, S3)", () => {
  it("counts keyboard and mouse edits, not reloads or plugin writes", () => {
    for (const e of ["input.type", "input.paste", "delete.backward", "undo", "redo", "move.drop", "input"]) expect(isHumanUserEvent(e), e).toBe(true);
    for (const e of ["set", "select", "inputx", undefined]) expect(isHumanUserEvent(e), String(e)).toBe(false);
  });
});

describe("VaultBundleSource.applyLocal", () => {
  it("updates the model at once, keeping the cached policy", async () => {
    const files = new Map([["K/a.md", "---\ntype: N\n---\n"], ["K/.okf.yaml", "raw_dirs: [raw]\n"]]);
    const port: VaultPort = {
      configDir: ".obsidian",
      listFiles: () => [...files.keys()].filter((f) => !f.includes("/.")),
      isFolder: (p) => [...files.keys()].some((f) => f.startsWith(`${p}/`)),
      readText: async (p) => files.get(p)!,
      readHidden: async (p) => files.get(p) ?? null,
      isSafeOnDisk: () => true,
      onChange: (_l: (c: VaultChange) => void) => () => undefined,
    };
    const source = new VaultBundleSource(port, () => [{ path: "K", enabled: true }]);
    await source.reload();
    const v1 = source.bundles()[0]!.version;
    source.applyLocal("K", new Map([["b.md", "---\ntype: N\ntitle: B\n---\n"], ["a.md", null]]));
    const h = source.bundles()[0]!;
    expect(h.version).toBeGreaterThan(v1);
    expect([...h.model.concepts.keys()]).toEqual(["b.md"]);
    expect(h.model.policy.raw_dirs).toEqual(["raw"]);
  });
});

describe("write settings", () => {
  it("sanitizes pause, quotas and the user id", () => {
    expect(sanitizeSettings({})).toMatchObject({ agentWritesPaused: false, writesPerMinute: 30, writesPerDay: 500, userId: "" });
    expect(sanitizeSettings({ agentWritesPaused: true, writesPerMinute: 5, writesPerDay: -1, userId: "ys" })).toMatchObject({ agentWritesPaused: true, writesPerMinute: 5, writesPerDay: 500, userId: "ys" });
    expect(sanitizeSettings({ userId: "bad id" }).userId).toBe("");
    expect(humanActor(sanitizeSettings({ userId: "ys" }))).toBe("human:ys");
    expect(humanActor(sanitizeSettings({}))).toBe("human:owner");
    expect(sanitizeSettings({}).autoApprove).toEqual({ enabled: false, tokens: [], bundles: [] });
    expect(sanitizeSettings({ autoApprove: { enabled: "yes", tokens: ["cc", 3], bundles: "K" } }).autoApprove).toEqual({ enabled: false, tokens: ["cc"], bundles: [] });
  });
});

describe("FileTrustLedger", () => {
  it("persists fingerprints and treats a damaged file as unknown", async () => {
    const a = new MemoryAdapter();
    const t = new FileTrustLedger(a, "state");
    t.set("K", "a.md", "fp1");
    t.set("K", "b.md", "fp2");
    t.set("K", "b.md", null);
    await t.flush();
    const again = new FileTrustLedger(a, "state");
    await again.load();
    expect(again.get("K", "a.md")).toBe("fp1");
    expect(again.get("K", "b.md")).toBeUndefined();
    a.files.set("state/trust.json", "{broken");
    const damaged = new FileTrustLedger(a, "state");
    await damaged.load();
    expect(damaged.get("K", "a.md")).toBeUndefined();
  });
});
