import { describe, expect, it } from "vitest";
import { parseConcept } from "../../src/core/document";
import { parseLog } from "../../src/core/logRender";
import { autoApproveRule, type AutoApproveSettings } from "../../src/service/autoApprove";
import { KnowledgeService } from "../../src/service/knowledgeService";
import { WriteService, type Writer } from "../../src/service/writeService";
import { ServiceError, type Scope } from "../../src/service/types";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../helpers-service";

const NOW = new Date("2026-10-22T08:00:00Z");

function setup(rules: Partial<AutoApproveSettings> = {}) {
  const provider = new MemoryProvider().set("K", new Map([[".okf.yaml", 'okf_version: "0.2"\n']]));
  const port = new MemoryFilePort(provider, () => NOW.getTime());
  const snapshots = new MemorySnapshots();
  const knowledge = new KnowledgeService(provider);
  const settings: AutoApproveSettings = { enabled: true, tokens: ["claude-code"], bundles: [], ...rules };
  let n = 0;
  let clock = NOW.getTime();
  const writes = new WriteService(provider, port, snapshots, new MemoryAudit(), { now: () => new Date(clock), newId: () => `c${++n}`, autoApprove: autoApproveRule(knowledge, () => settings) });
  const file = (p: string) => provider.files.get("K")!.get(p);
  const later = () => void (clock += 3_600_000);
  return { provider, port, knowledge, writes, settings, file, later };
}

const agent = (name = "claude-code", scopes: Scope[] = ["read", "write"]): Writer => ({
  kind: "token",
  principal: principal({ tokenName: name, scopes: new Set(scopes) }),
  actor: `${name}/1`,
});
const person: Writer = { kind: "human", actor: "human:ys" };

const sourced = (id = "notes/flood", body = "Floods are mapped from radar.[^s]\n\n[^s]: [Flood report](https://example.org/flood)\n") => ({
  kind: "create" as const,
  conceptId: id,
  frontmatter: { type: "Concept", title: "Flood mapping", description: "Mapping floods from satellite radar.", tags: ["flood"], sources: [{ id: "s", resource: "https://example.org/flood", title: "Flood report" }] },
  body,
  reason: "First draft.",
});

describe("auto approve", () => {
  it("approves a clean write from a listed token in the same write, so the next write does not conflict", async () => {
    const { writes, knowledge, file } = setup();
    const r = await writes.write(agent(), "K", sourced(), "okf_create");
    expect(r).toMatchObject({ status: "stable", trust_tier: "machine-confirmed" });
    const fm = parseConcept(file("notes/flood.md")!).frontmatter;
    expect(fm["verified"]).toEqual([{ by: "process:auto-approve", at: "2026-10-22T08:00:00Z" }]);
    expect(parseLog(file("log.md")!).map((e) => [e.action, e.actor])).toEqual([["Creation", "claude-code/1"], ["Approval", "process:auto-approve"]]);
    expect(knowledge.reviewQueue()).toEqual([]);
    const next = await writes.write(agent(), "K", { kind: "update", conceptId: "notes/flood", ifMatch: r.etag!, reason: "Tag.", patch: { tags_add: ["radar"] } }, "okf_update");
    expect(next.status).toBe("stable");
  });

  it("leaves to a person: other tokens and bundles, no sources, lint warnings, review requests", async () => {
    const off = setup({ tokens: ["someone-else"] });
    expect((await off.writes.write(agent(), "K", sourced(), "okf_create")).status).toBe("draft");
    expect((await setup({ bundles: ["Other"] }).writes.write(agent(), "K", sourced(), "okf_create")).status).toBe("draft");

    const { writes, knowledge } = setup();
    const bare = { ...sourced("notes/bare", "Floods happen.\n"), frontmatter: { type: "Concept", title: "Bare", description: "No sources." } };
    expect((await writes.write(agent(), "K", bare, "okf_create")).status).toBe("draft");
    expect(knowledge.approvalBlockers("K", "notes/bare")).toContain("no sources");
    expect((await writes.write(agent(), "K", sourced("notes/uncited", "Floods are mapped from radar.\n"), "okf_create")).status).toBe("draft");
    expect(knowledge.approvalBlockers("K", "notes/uncited")).toEqual(["no footnote cites a source"]);
    await writes.write(agent("other"), "K", sourced("notes/asked"), "okf_create");
    await writes.write(agent("other"), "K", { kind: "request_review", conceptId: "notes/asked", note: "Check the numbers." }, "okf_request_review");
    expect(knowledge.approvalBlockers("K", "notes/asked")).toEqual(["review requested"]);
  });

  it("never re-approves what a person approved: an agent edit goes back to the person", async () => {
    const { writes, knowledge, settings, later } = setup();
    settings.enabled = false;
    await writes.write(agent(), "K", sourced(), "okf_create");
    const approved = await writes.write(person, "K", { kind: "verify", conceptId: "notes/flood", approve: true }, "approve");
    settings.enabled = true;
    later();
    const edited = await writes.write(agent(), "K", { kind: "update", conceptId: "notes/flood", ifMatch: approved.etag!, reason: "More.", patch: { tags_add: ["radar"] } }, "okf_update");
    expect(edited.status).toBe("stable");
    expect(knowledge.approvalBlockers("K", "notes/flood")).toEqual(["approved by a person before"]);
    expect(knowledge.reviewQueue()[0]!.reasons).toContain("changed since verified");
  });
});

describe("reject", () => {
  it("reverts the agent's draft with the person's reason, which agents read in the log", async () => {
    const { writes, port, file, settings } = setup();
    settings.enabled = false;
    await writes.write(agent(), "K", sourced(), "okf_create");
    await writes.reject("human:ys", "K", "notes/flood", "  Wrong\nsource. ");
    expect(file("notes/flood.md")).toBeUndefined();
    expect(port.trashed).toEqual(["notes/flood.md"]);
    const last = parseLog(file("log.md")!).at(-1)!;
    expect(last).toMatchObject({ action: "Revert", actor: "human:ys" });
    expect(last.reason).toMatch(/^Rejected: Wrong source\. \(revert of commit c1\)/);
  });

  it("keeps the reason readable in okf_history by concept id after the draft is gone", async () => {
    const { writes, knowledge, settings } = setup();
    settings.enabled = false;
    await writes.write(agent(), "K", sourced(), "okf_create");
    await writes.reject("human:ys", "K", "notes/flood", "Wrong source.");
    const h = knowledge.history(principal(), { bundle: "K", concept_id: "notes/flood" });
    expect(h.entries.map((e) => e.action)).toEqual(["Revert", "Creation"]);
    expect(h.entries[0]!.reason).toMatch(/^Rejected: Wrong source\./);
    expect(() => knowledge.history(principal({ pathPrefixes: ["other"] }), { bundle: "K", concept_id: "notes/flood" })).toThrow(ServiceError);
  });

  it("undoes an auto approval together with the write it approved", async () => {
    const { writes, file } = setup();
    await writes.write(agent(), "K", sourced(), "okf_create");
    await writes.reject("human:ys", "K", "notes/flood", "Not needed.");
    expect(file("notes/flood.md")).toBeUndefined();
    // Both reverts land in one log entry (same day, actor and concept).
    expect(parseLog(file("log.md")!).at(-1)!.reason).toMatch(/revert of commit c2\).*revert of commit c1\)/);
  });

  it("needs a reason and an agent change to undo", async () => {
    const { writes } = setup();
    const err = async (p: Promise<unknown>) => p.then(() => null, (e: ServiceError) => e.code);
    expect(await err(writes.reject("human:ys", "K", "notes/flood", " "))).toBe("invalid-argument");
    expect(await err(writes.reject("human:ys", "K", "notes/flood", "Why."))).toBe("not-found");
  });
});
