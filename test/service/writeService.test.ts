import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseConcept } from "../../src/core/document";
import { lintBundle } from "../../src/core/lint";
import { parseLog } from "../../src/core/logRender";
import { etagOf } from "../../src/core/write";
import { BEING_EDITED_MS, WriteService, type Writer } from "../../src/service/writeService";
import { ServiceError, type Scope } from "../../src/service/types";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../helpers-service";
import { loadFixtureBundle } from "../helpers";

const NOW = new Date("2026-10-19T08:00:00Z");

function setup(opts: { paused?: boolean; perMinute?: number; perDay?: number; files?: Map<string, string> } = {}) {
  const provider = new MemoryProvider().set("K", opts.files ?? new Map([[".okf.yaml", 'okf_version: "0.2"\n']]));
  const port = new MemoryFilePort(provider, () => NOW.getTime());
  const snapshots = new MemorySnapshots();
  const audit = new MemoryAudit();
  let n = 0;
  const service = new WriteService(provider, port, snapshots, audit, {
    now: () => NOW,
    newId: () => `c${++n}`,
    paused: () => opts.paused ?? false,
    ...(opts.perMinute ? { perMinute: opts.perMinute } : {}),
    ...(opts.perDay ? { perDay: opts.perDay } : {}),
  });
  const files = () => provider.files.get("K")!;
  return { provider, port, snapshots, audit, service, files };
}

const agent = (scopes: Scope[] = ["read", "write"], over = {}): Writer => ({
  kind: "token",
  principal: principal({ tokenName: "claude-code", scopes: new Set(scopes), ...over }),
  actor: "claude-code/opus-5.5",
});

async function err(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error("expected a ServiceError");
}

const create = (id = "concepts/remote-sensing", body = "Remote sensing observes Earth.\n") => ({
  kind: "create" as const,
  conceptId: id,
  frontmatter: { type: "Concept", title: "Remote sensing", description: "Observing Earth from a distance." },
  body,
  reason: "First draft.",
});

describe("writes", () => {
  it("writes the concept, regenerates indexes, logs, snapshots and audits", async () => {
    const { service, files, snapshots, audit, provider } = setup();
    const r = await service.write(agent(), "K", create(), "okf_create");
    expect(r).toMatchObject({ changed: true, concept_id: "concepts/remote-sensing", status: "draft", trust_tier: "unverified", commit_id: "c1" });
    expect(r.etag).toBe(etagOf(files().get("concepts/remote-sensing.md")!));
    expect(files().get("concepts/index.md")).toContain("* [Remote sensing (draft)](remote-sensing.md) - Observing Earth from a distance.");
    expect(files().get("index.md")).toContain("[concepts](concepts/index.md)");
    expect(parseLog(files().get("log.md")!)).toEqual([
      expect.objectContaining({ date: "2026-10-19", action: "Creation", link: "concepts/remote-sensing.md", reason: "First draft.", actor: "claude-code/opus-5.5" }),
    ]);
    expect(snapshots.records[0]!.files.map((f) => f.path).sort()).toEqual(["concepts/index.md", "concepts/remote-sensing.md", "index.md", "log.md"]);
    expect(audit.entries).toEqual([expect.objectContaining({ outcome: "written", commit_id: "c1", token: "claude-code" })]);
    expect(provider.bundles()[0]!.model.concepts.has("concepts/remote-sensing.md")).toBe(true);
    expect(lintBundle(provider.bundles()[0]!.model).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("regenerates only the indexes of the written directory and its ancestors", async () => {
    const acme = loadFixtureBundle("acme_retail").set(".okf.yaml", 'okf_version: "0.2"\n');
    const { service, files } = setup({ files: acme });
    await service.write(agent(), "K", create("policies/returns"), "okf_create");
    expect(files().get("policies/index.md")).toContain("returns.md");
    expect(files().get("index.md")).not.toBe(acme.get("index.md"));
    for (const dir of ["tables", "metrics", "computations", "skills"]) expect(files().get(`${dir}/index.md`)).toBe(acme.get(`${dir}/index.md`));
  });

  it("returns guard errors with codes and audits refusals", async () => {
    const { service, audit } = setup();
    expect((await err(service.write(agent(), "K", { ...create(), frontmatter: { type: "Concept", title: "ดาวเทียม" } }, "okf_create"))).code).toBe("policy");
    expect(audit.entries.at(-1)).toMatchObject({ outcome: "refused", code: "policy" });
  });

  it("detects a change landing between planning and writing", async () => {
    const { service, port, files, snapshots } = setup();
    await service.write(agent(), "K", create(), "okf_create");
    const text = files().get("concepts/remote-sensing.md")!;
    port.interfere = (_b, path) => {
      if (path === "concepts/remote-sensing.md") files().set(path, `${text}\nA person typed this.\n`);
    };
    const e = await err(service.write(agent(), "K", { kind: "update", conceptId: "concepts/remote-sensing", ifMatch: etagOf(text), reason: "Expand.", bodyOps: [{ op: "append", content: "More." }] }, "okf_update"));
    expect(e.code).toBe("conflict");
    expect(files().get("concepts/remote-sensing.md")).toContain("A person typed this.");
    expect(snapshots.records).toHaveLength(1); // the aborted commit's snapshot was discarded
  });

  it("refuses while a person is typing in the file", async () => {
    const { service, port, files } = setup();
    await service.write(agent(), "K", create(), "okf_create");
    port.typing.set("K/concepts/remote-sensing.md", NOW.getTime() - 2000);
    const text = files().get("concepts/remote-sensing.md")!;
    const e = await err(service.write(agent(), "K", { kind: "update", conceptId: "concepts/remote-sensing", ifMatch: etagOf(text), reason: "x", patch: { merge: { description: "Changed." } } }, "okf_update"));
    expect(e.code).toBe("being-edited");
    expect(e.data?.["retry_after"]).toBeGreaterThan(0);
    port.typing.set("K/concepts/remote-sensing.md", NOW.getTime() - BEING_EDITED_MS - 1);
    expect((await service.write(agent(), "K", { kind: "update", conceptId: "concepts/remote-sensing", ifMatch: etagOf(text), reason: "x", patch: { merge: { description: "Changed." } } }, "okf_update")).changed).toBe(true);
  });

  it("honours pause, quota, scopes and path limits", async () => {
    expect((await err(setup({ paused: true }).service.write(agent(), "K", create(), "okf_create"))).code).toBe("paused");
    const { service } = setup({ perMinute: 2 });
    await service.write(agent(), "K", create("concepts/a"), "okf_create");
    await service.write(agent(), "K", create("concepts/b"), "okf_create");
    const limited = await err(service.write(agent(), "K", create("concepts/c"), "okf_create"));
    expect(limited.code).toBe("rate-limited");
    expect(limited.data?.["retry_after"]).toBeGreaterThan(0);
    expect((await err(setup().service.write(agent(["read"]), "K", create(), "okf_create"))).code).toBe("forbidden");
    expect((await err(setup().service.write(agent(["read", "write"], { pathPrefixes: ["decisions"] }), "K", create(), "okf_create"))).code).toBe("forbidden");
    expect((await err(setup().service.write(agent(["read", "write"], { bundles: ["Other"] }), "K", create(), "okf_create"))).code).toBe("not-found");
  });

  it("serializes concurrent writes to one bundle", async () => {
    const { service, files } = setup();
    await Promise.all(["a", "b", "c", "d", "e"].map((x) => service.write(agent(), "K", create(`concepts/${x}`), "okf_create")));
    const log = parseLog(files().get("log.md")!);
    expect(log.filter((e) => e.action === "Creation")).toHaveLength(5);
    expect(files().get("concepts/index.md")!.match(/^\* /gm)).toHaveLength(5);
  });
});

describe("moves, directory descriptions and revert", () => {
  it("moves a concept and rewrites links to it", async () => {
    const { service, files, provider } = setup({ files: loadFixtureBundle("acme_retail") });
    const text = files().get("metrics/revenue.md")!;
    const r = await service.move(agent(), "K", { from: "metrics/revenue", to: "metrics/recognized-revenue", ifMatch: etagOf(text), reason: "Clearer name." });
    expect(r.changed).toBe(true);
    expect(files().has("metrics/revenue.md")).toBe(false);
    expect(files().has("metrics/recognized-revenue.md")).toBe(true);
    const model = provider.bundles()[0]!.model;
    expect(model.backlinks.get("metrics/recognized-revenue.md")?.length).toBeGreaterThan(0);
    expect(model.backlinks.get("metrics/revenue.md")).toBeUndefined();
    expect(files().get("metrics/index.md")).toContain("(recognized-revenue.md)");
    expect(parseLog(files().get("log.md")!)[0]).toMatchObject({ action: "Move", link: "metrics/recognized-revenue.md" });
  });

  it("points earlier log entries at the moved concept's new path", async () => {
    const { service, files } = setup();
    await service.write(agent(), "K", create("concepts/a"), "okf_create");
    await service.move(agent(), "K", { from: "concepts/a", to: "concepts/b", ifMatch: etagOf(files().get("concepts/a.md")!), reason: "Rename." });
    const log = parseLog(files().get("log.md")!);
    expect(log.map((e) => [e.action, e.link])).toEqual([["Creation", "concepts/b.md"], ["Move", "concepts/b.md"]]);
  });

  it("refuses moves across zones, onto existing files, or with a stale etag", async () => {
    const { service, files } = setup({ files: loadFixtureBundle("acme_retail") });
    const etag = etagOf(files().get("metrics/revenue.md")!);
    expect((await err(service.move(agent(), "K", { from: "metrics/revenue", to: "references/raw/revenue", ifMatch: etag, reason: "x" }))).code).toBe("policy");
    expect((await err(service.move(agent(), "K", { from: "metrics/revenue", to: "metrics/gross-margin", ifMatch: etag, reason: "x" }))).code).toBe("exists");
    expect((await err(service.move(agent(), "K", { from: "metrics/revenue", to: "metrics/x", ifMatch: "0".repeat(64), reason: "x" }))).code).toBe("conflict");
  });

  it("describes a directory in its parent index", async () => {
    const { service, files } = setup({ files: loadFixtureBundle("acme_retail") });
    await service.describeDirectory(agent(), "K", "metrics", "Headline finance metrics.");
    expect(files().get("index.md")).toContain("* [metrics](metrics/index.md) - Headline finance metrics.");
    expect((await err(service.describeDirectory(agent(), "K", "metrics", "ตัวชี้วัด"))).code).toBe("policy");
  });

  it("reverts a commit, and refuses when the file changed since", async () => {
    const { service, files, port } = setup();
    const created = await service.write(agent(), "K", create(), "okf_create");
    const text = files().get("concepts/remote-sensing.md")!;
    const updated = await service.write(agent(), "K", { kind: "update", conceptId: "concepts/remote-sensing", ifMatch: etagOf(text), reason: "Expand.", bodyOps: [{ op: "append", content: "More detail." }] }, "okf_update");
    await service.revert("human:ys", updated.commit_id!);
    expect(files().get("concepts/remote-sensing.md")).toBe(text);
    expect(parseLog(files().get("log.md")!).map((e) => e.action)).toContain("Revert");
    // The creation can no longer be reverted blindly: the file is unchanged since, so it can.
    await service.revert("human:ys", created.commit_id!);
    expect(files().has("concepts/remote-sensing.md")).toBe(false);
    expect(port.trashed).toEqual(["concepts/remote-sensing.md"]);
    expect((await err(service.revert("human:ys", "nope"))).code).toBe("not-found");
  });
});

describe("Phase 2 exit criterion: random agent writes keep the bundle conformant", () => {
  it("100 random concepts, updates and moves leave no lint errors", async () => {
    // The clock is frozen, so lift the quota or it would stop the run after 30 writes.
    const { service, files, provider, snapshots } = setup({ perMinute: 10_000, perDay: 10_000 });
    const word = fc.constantFrom("orbit", "sensor", "flood", "rice", "forest", "coast", "radar", "band", "pixel", "cloud");
    const ops = fc.sample(fc.tuple(fc.array(word, { minLength: 1, maxLength: 3 }), fc.array(word, { minLength: 3, maxLength: 30 }), fc.nat(9)), { numRuns: 100, seed: 42 });
    const made: string[] = [];
    for (const [nameWords, bodyWords, kind] of ops) {
      const id = `concepts/${nameWords.join("-")}-${made.length}`;
      const linkTo = made.length ? `See [[${made[made.length - 1]!.split("/").pop()}]].` : "";
      try {
        if (kind < 7 || made.length === 0) {
          await service.write(agent(), "K", { kind: "create", conceptId: id, frontmatter: { type: "Concept", title: nameWords.join(" "), tags: nameWords }, body: `${bodyWords.join(" ")}.\n\n${linkTo}\n`, reason: "Random." }, "okf_create");
          made.push(id);
        } else if (kind < 9) {
          const target = made[kind % made.length]!;
          const t = files().get(`${target}.md`)!;
          await service.write(agent(), "K", { kind: "update", conceptId: target, ifMatch: etagOf(t), reason: "Random update.", bodyOps: [{ op: "append", content: `${bodyWords.join(" ")}. ${linkTo}` }] }, "okf_update");
        } else {
          const target = made[kind % made.length]!;
          const to = `${target}-moved`;
          await service.move(agent(), "K", { from: target, to, ifMatch: etagOf(files().get(`${target}.md`)!), reason: "Random move." });
          made[made.indexOf(target)] = to;
        }
      } catch (e) {
        // A random update may legitimately be refused (e.g. a too-similar move target).
        if (!(e instanceof ServiceError) || !["exists", "policy"].includes(e.code)) throw e;
      }
    }
    expect(snapshots.records.length).toBeGreaterThanOrEqual(95);
    expect(snapshots.records.some((r) => r.tool === "okf_move")).toBe(true);
    expect(snapshots.records.some((r) => r.tool === "okf_update")).toBe(true);
    const model = provider.bundles()[0]!.model;
    expect(lintBundle(model).filter((d) => d.severity === "error")).toEqual([]);
    for (const c of model.concepts.values()) expect(parseConcept(files().get(c.path)!).frontmatter["generated"]).toBeDefined();
  }, 30_000); // about 100 commits; slower when the suite runs in parallel
});
