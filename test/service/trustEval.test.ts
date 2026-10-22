// Phase 3 exit criterion: the trust tier and attestation match what really happened, in
// every scenario, including edits from sync, git and renames outside the plugin.

import { describe, expect, it } from "vitest";
import { etagOf } from "../../src/core/write";
import { KnowledgeService } from "../../src/service/knowledgeService";
import type { TrustLedger } from "../../src/service/types";
import { WriteService, type Writer } from "../../src/service/writeService";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../helpers-service";

class MemoryTrust implements TrustLedger {
  map = new Map<string, string>();
  get(b: string, p: string) { return this.map.get(`${b}/${p}`); }
  set(b: string, p: string, fp: string | null) { if (fp === null) this.map.delete(`${b}/${p}`); else this.map.set(`${b}/${p}`, fp); }
}

const NOW = new Date("2026-10-20T08:00:00Z");
const ID = "concepts/remote-sensing";

function setup() {
  const provider = new MemoryProvider().set("K", new Map([[".okf.yaml", 'okf_version: "0.2"\n']]));
  const trust = new MemoryTrust();
  const writes = new WriteService(provider, new MemoryFilePort(provider), new MemorySnapshots(), new MemoryAudit(), { now: () => NOW, trust });
  const knowledge = new KnowledgeService(provider, () => NOW, trust);
  const agent: Writer = { kind: "token", principal: principal({ tokenName: "claude-code", scopes: new Set(["read", "write"]) }), actor: "claude-code/1" };
  const human: Writer = { kind: "human", actor: "human:ys" };
  const reader = principal();
  const text = () => provider.files.get("K")!.get(`${ID}.md`)!;
  const view = () => knowledge.read(reader, { concept_id: ID });
  /** An edit made outside the plugin (git pull, sync, a script) that the vault reports. */
  const external = (next: string) => provider.applyLocal("K", new Map([[`${ID}.md`, next]]));
  const codes = () => knowledge.lint(reader, { concept_id: ID }).diagnostics.map((d) => d.code);
  return { provider, writes, knowledge, agent, human, text, view, external, codes, trust };
}

const create = { kind: "create" as const, conceptId: ID, frontmatter: { type: "Concept", title: "Remote sensing" }, body: "Observing Earth.\n", reason: "Draft." };

describe("trust tier evaluation", () => {
  it("agent draft -> person approves -> agent edits -> person approves again", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    expect(t.view()).toMatchObject({ status: "draft", trust_tier: "unverified", trust_attested: true, verification_outdated: false });
    expect(t.knowledge.reviewQueue()[0]?.reasons).toEqual(["draft"]);

    await t.writes.write(t.human, "K", { kind: "verify", conceptId: ID, approve: true }, "approve");
    expect(t.view()).toMatchObject({ status: "stable", trust_tier: "human-reviewed", trust_attested: true, verification_outdated: false });
    expect(t.knowledge.reviewQueue()).toEqual([]);

    // Later than the approval, so the content change is visible against it.
    const later = new WriteService(t.provider, new MemoryFilePort(t.provider), new MemorySnapshots(), new MemoryAudit(), { now: () => new Date("2026-10-21T08:00:00Z"), trust: t.trust });
    await later.write(t.agent, "K", { kind: "update", conceptId: ID, ifMatch: etagOf(t.text()), reason: "Expand.", bodyOps: [{ op: "append", content: "More." }] }, "okf_update");
    expect(t.view()).toMatchObject({ trust_tier: "human-reviewed", verification_outdated: true, trust_attested: true });
    expect(t.knowledge.reviewQueue()[0]?.reasons).toContain("changed since verified");
  });

  it("a verified entry forged outside the plugin is detected", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    t.external(t.text().replace("status: draft", "status: draft\nverified:\n  - { by: human:ys, at: 2026-10-20T07:00:00Z }"));
    expect(t.view()).toMatchObject({ trust_tier: "human-reviewed", trust_attested: false });
    expect(t.codes()).toContain("unattested-verification");
    expect(t.knowledge.reviewQueue()[0]?.reasons).toContain("unattested-verification");
  });

  it("a draft made stable outside the plugin is detected", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    t.external(t.text().replace("status: draft", "status: stable"));
    expect(t.view()).toMatchObject({ status: "stable", trust_attested: false });
    expect(t.codes()).toContain("unattested-publish");
  });

  it("a sync that rewrites the YAML layout or the body keeps attestation", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    await t.writes.write(t.human, "K", { kind: "verify", conceptId: ID, approve: true }, "approve");
    // Obsidian's Properties UI or a sync client reformats flow style into block style.
    const reformatted = t.text().replace(/generated: \{ by: (\S+), at: (\S+) \}/, "generated:\n  by: $1\n  at: $2").replace(/- \{ by: (\S+), at: (\S+) \}/, "- by: $1\n    at: $2") + "\nA line added on another device.\n";
    t.external(reformatted);
    expect(t.view()).toMatchObject({ trust_tier: "human-reviewed", trust_attested: true });
    expect(t.codes()).not.toContain("unattested-verification");
  });

  it("our own move keeps attestation; a rename outside the plugin makes it unknown", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    await t.writes.move(t.agent, "K", { from: ID, to: "concepts/sensing", ifMatch: etagOf(t.text()), reason: "Rename." });
    expect(t.knowledge.read(principal(), { concept_id: "concepts/sensing" }).trust_attested).toBe(true);

    const files = t.provider.files.get("K")!;
    t.provider.applyLocal("K", new Map([["concepts/sensing.md", null], ["concepts/moved-by-git.md", files.get("concepts/sensing.md")!]]));
    expect(t.knowledge.read(principal(), { concept_id: "concepts/moved-by-git" }).trust_attested).toBeNull();
  });

  it("a review request shows in the queue and approval clears it", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    await t.writes.write(t.agent, "K", { kind: "request_review", conceptId: ID, note: "Please check the definition." }, "okf_request_review");
    expect(t.knowledge.reviewQueue()[0]?.reasons).toEqual(["draft", "review requested"]);
    await t.writes.write(t.human, "K", { kind: "verify", conceptId: ID, approve: true }, "approve");
    expect(t.knowledge.reviewQueue()).toEqual([]);
  });

  it("a reverted commit stays attested", async () => {
    const t = setup();
    await t.writes.write(t.agent, "K", create, "okf_create");
    const approved = await t.writes.write(t.human, "K", { kind: "verify", conceptId: ID, approve: true }, "approve");
    await t.writes.revert("human:ys", approved.commit_id!);
    expect(t.view()).toMatchObject({ status: "draft", trust_attested: true });
  });
});
