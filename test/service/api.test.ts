import { describe, expect, it } from "vitest";
import { ExtensionHost, API_VERSION, type CommitEvent } from "../../src/api";
import { etagOf } from "../../src/core/write";
import { KnowledgeService } from "../../src/service/knowledgeService";
import type { Scope } from "../../src/service/types";
import { WriteService, type Writer } from "../../src/service/writeService";
import { loadFixtureBundle } from "../helpers";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../helpers-service";

function setup() {
  const provider = new MemoryProvider().set("K", loadFixtureBundle("acme_retail").set(".okf.yaml", 'okf_version: "0.2"\nraw_dirs: [references/raw]\n'));
  const host = new ExtensionHost(new KnowledgeService(provider));
  let n = 0;
  const writes = new WriteService(provider, new MemoryFilePort(provider), new MemorySnapshots(), new MemoryAudit(), { newId: () => `c${++n}`, onCommit: (e) => host.emit(e) });
  const events: CommitEvent[] = [];
  host.api.onCommit((e) => events.push(e));
  const text = (path: string) => provider.files.get("K")!.get(path)!;
  return { provider, host, writes, events, text };
}

const agent: Writer = { kind: "token", principal: principal({ tokenName: "claude-code", scopes: new Set<Scope>(["read", "write"]) }), actor: "claude-code/1" };
const person: Writer = { kind: "human", actor: "human:ys" };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("extension API", () => {
  it("hears every commit, agent, person and revert, with the files each one wrote", async () => {
    const { writes, events, text } = setup();
    const ids: string[] = [];
    const run = async (p: Promise<{ commit_id?: string }>) => {
      ids.push((await p).commit_id!);
      await settle();
    };
    await run(writes.write(agent, "K", { kind: "create", conceptId: "notes/a", frontmatter: { type: "Note", title: "A", description: "x" }, body: "A.\n" }, "okf_create"));
    await run(writes.write(agent, "K", { kind: "update", conceptId: "notes/a", ifMatch: etagOf(text("notes/a.md")), reason: "More.", bodyOps: [{ op: "append", content: "More." }] }, "okf_update"));
    await run(writes.write(person, "K", { kind: "verify", conceptId: "notes/a", approve: true }, "verify"));
    await run(writes.move(agent, "K", { from: "notes/a", to: "notes/b", ifMatch: etagOf(text("notes/a.md")), reason: "Rename." }));
    await run(writes.write(agent, "K", { kind: "deprecate", conceptId: "notes/b", reason: "Superseded." }, "okf_deprecate"));
    await run(writes.write(agent, "K", { kind: "ingest_raw", slug: "memo", title: "Memo", description: "A memo.", language: "th", resource: "x", body: "ต้นฉบับ\n" }, "okf_ingest_raw"));
    await run(writes.describeDirectory(agent, "K", "notes", "Working notes."));
    const reverted = await writes.revert("human:ys", ids[4]!);
    await settle();

    expect(events.map((e) => e.tool)).toEqual(["okf_create", "okf_update", "verify", "okf_move", "okf_deprecate", "okf_ingest_raw", "okf_describe_directory", "revert"]);
    expect(events.slice(0, -1).map((e) => e.commitId)).toEqual(ids);
    const changes = (i: number) => Object.fromEntries(events[i]!.changes.map((c) => [c.path, c.change]));
    expect(changes(0)).toMatchObject({ "notes/a.md": "created", "log.md": "modified" });
    expect(changes(3)).toMatchObject({ "notes/a.md": "deleted", "notes/b.md": "created" });
    expect(events[2]!.actor).toBe("human:ys");
    // The revert carries the file it restored, not only the regenerated index and log.
    expect(events[7]).toMatchObject({ commitId: reverted.commit_id, reverts: ids[4], actor: "human:ys" });
    expect(changes(7)).toMatchObject({ "notes/b.md": "modified" });
  });

  it("reads like an agent and cannot write: no write member, results are copies", async () => {
    const { host, writes } = setup();
    expect(Object.keys(host.api).sort()).toEqual(["apiVersion", "bundles", "onCommit", "read", "search"]);
    expect(host.api.apiVersion).toBe(API_VERSION);
    expect(Object.isFrozen(host.api)).toBe(true);
    expect(host.api.bundles().bundles.map((b) => b.name)).toEqual(["K"]);
    expect(host.api.search({ query: "gross margin" }).hits[0]?.concept_id).toMatch(/gross-margin/);
    const first = host.api.read({ concept_id: "metrics/revenue", view: "frontmatter" });
    (first.frontmatter as Record<string, unknown>)["title"] = "Changed by an extension";
    expect(host.api.read({ concept_id: "metrics/revenue", view: "frontmatter" }).frontmatter?.["title"]).toBe("Revenue");
    expect(writes).toBeDefined();
  });

  it("keeps going when a listener throws, unsubscribes, and switches off on unload", async () => {
    const { host, writes, events } = setup();
    const errors: unknown[] = [];
    const logged = new ExtensionHost(new KnowledgeService(new MemoryProvider()), (_m, e) => errors.push(e));
    logged.api.onCommit(() => {
      throw new Error("bad extension");
    });
    const seen: string[] = [];
    const off = logged.api.onCommit((e) => seen.push(e.commitId));
    const event: CommitEvent = { commitId: "x1", at: "", bundle: "K", actor: "a/1", tool: "t", conceptId: "c", changes: [] };
    logged.emit(event);
    expect(seen).toEqual(["x1"]);
    expect(errors).toHaveLength(1);
    off();
    logged.emit({ ...event, commitId: "x2" });
    expect(seen).toEqual(["x1"]);

    host.dispose();
    await writes.write(agent, "K", { kind: "create", conceptId: "notes/z", frontmatter: { type: "Note", title: "Z" }, body: "Z.\n" }, "okf_create");
    await settle();
    expect(events).toEqual([]);
    expect(() => host.api.bundles()).toThrow(/unloaded/);
    expect(() => host.api.onCommit(() => undefined)).toThrow(/unloaded/);
  });
});
