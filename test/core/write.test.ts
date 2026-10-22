// planWrite: every guard in DESIGN.md §6 / §4.3 / §4.7 / §4.8 blocks what it should and
// lets through what it should.

import { describe, expect, it } from "vitest";
import { analyzeBundle } from "../../src/core/bundle";
import { parseConcept } from "../../src/core/document";
import { lintBundle } from "../../src/core/lint";
import { rawContentHash } from "../../src/core/raw";
import { etagOf, planWrite, WriteError, type WriteContext, type WriteRequest } from "../../src/core/write";
import { loadFixtureBundle } from "../helpers";

const NOW = new Date("2026-10-19T08:00:00Z");
const ACTOR = "claude-code/opus-5.5";

function ctxFor(files: Map<string, string>, scopes: string[] = ["read", "write"]): WriteContext {
  return { model: analyzeBundle(files), actor: ACTOR, can: (s) => scopes.includes(s), now: NOW };
}

const acme = () => loadFixtureBundle("acme_retail");
const base = () => new Map<string, string>([[".okf.yaml", 'okf_version: "0.2"\n']]);

function fail(req: WriteRequest, ctx: WriteContext): WriteError {
  try {
    planWrite(req, ctx);
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw e;
  }
  throw new Error("expected a WriteError");
}

describe("create", () => {
  const req = (over: Partial<Extract<WriteRequest, { kind: "create" }>> = {}): WriteRequest => ({
    kind: "create",
    conceptId: "concepts/remote-sensing",
    frontmatter: { type: "Concept", title: "Remote sensing", description: "Observing Earth from a distance.", tags: ["eo"] },
    body: "Remote sensing uses [[satellite-imagery]] and [orders](/tables/orders.md).\n",
    ...over,
  });

  it("creates a draft stamped with the actor, with normalized links", () => {
    const plan = planWrite(req(), ctxFor(acme()));
    const { frontmatter, body } = parseConcept(plan.after);
    expect(frontmatter["status"]).toBe("draft");
    expect(frontmatter["generated"]).toEqual({ by: ACTOR, at: "2026-10-19T08:00:00Z" });
    expect(body).toContain("[orders](../tables/orders.md)");
    expect(body).toContain("[satellite-imagery](../satellite-imagery.md)");
    expect(plan.warnings.join()).toMatch(/does not resolve/);
    expect(plan.action).toBe("Creation");
  });

  it("refuses bad ids, existing files, raw dirs, missing type and server-owned fields", () => {
    const c = ctxFor(acme());
    expect(fail(req({ conceptId: "Concepts/Remote Sensing" }), c).code).toBe("invalid-argument");
    expect(fail(req({ conceptId: "metrics/revenue" }), c).code).toBe("exists");
    expect(fail(req({ conceptId: "references/raw/x" }), c).code).toBe("policy");
    expect(fail(req({ frontmatter: { title: "No type" } }), c).code).toBe("invalid-argument");
    expect(fail(req({ frontmatter: { type: "Concept", verified: { by: "human:x" } } }), c).code).toBe("forbidden");
    expect(fail(req({ frontmatter: { type: "Concept", generated: { by: "human:x" } } }), c).code).toBe("forbidden");
  });

  it("keeps agents from creating stable concepts without publish", () => {
    expect(fail(req({ frontmatter: { type: "Concept", status: "stable" } }), ctxFor(acme())).code).toBe("forbidden");
    expect(parseConcept(planWrite(req({ frontmatter: { type: "Concept", status: "stable" } }), ctxFor(acme(), ["write", "publish"])).after).frontmatter["status"]).toBe("stable");
    const stablePolicy = acme();
    stablePolicy.set(".okf.yaml", "agent_initial_status: stable\n");
    expect(parseConcept(planWrite(req(), ctxFor(stablePolicy)).after).frontmatter["status"]).toBe("stable");
  });

  it("enforces the English policy for curated concepts", () => {
    expect(fail(req({ body: "ดาวเทียมสำรวจทรัพยากรถ่ายภาพพื้นที่น้ำท่วมในภาคเหนือ\n" }), ctxFor(acme())).code).toBe("policy");
    expect(fail(req({ frontmatter: { type: "Concept", title: "การรับรู้จากระยะไกล" } }), ctxFor(acme())).code).toBe("policy");
    expect(planWrite(req({ frontmatter: { type: "Concept", title: "Remote sensing", aliases: ["การรับรู้จากระยะไกล"] } }), ctxFor(acme())).changed).toBe(true);
  });

  it("needs computations:write to author an Attested Computation", () => {
    const ac = req({ conceptId: "computations/x", frontmatter: { type: "Attested Computation", runtime: "bigquery" }, body: "# Computation\n\n    SELECT 1\n" });
    expect(fail(ac, ctxFor(acme())).code).toBe("forbidden");
    expect(planWrite(ac, ctxFor(acme(), ["write", "computations:write"])).changed).toBe(true);
  });
});

describe("update", () => {
  const files = acme();
  const ctx = ctxFor(files);
  const text = files.get("metrics/revenue.md")!;
  const etag = etagOf(text);
  const req = (over: Partial<Extract<WriteRequest, { kind: "update" }>> = {}): WriteRequest => ({ kind: "update", conceptId: "metrics/revenue", ifMatch: etag, reason: "Clarify the definition.", ...over });

  it("patches frontmatter and body sections, stamping generated and keeping other bytes", () => {
    const plan = planWrite(req({ patch: { merge: { description: "Recognized revenue for a period." }, tags_add: ["kpi"] }, bodyOps: [{ op: "append", content: "See [[gross-margin]]." }] }), ctx);
    const { frontmatter, body } = parseConcept(plan.after);
    expect(frontmatter["description"]).toBe("Recognized revenue for a period.");
    expect(frontmatter["generated"]).toEqual({ by: ACTOR, at: "2026-10-19T08:00:00Z" });
    expect(body.trimEnd().endsWith("See [gross-margin](gross-margin.md).")).toBe(true);
    const before = text.split("\n");
    expect(plan.after.split("\n").filter((l) => !before.includes(l)).length).toBeLessThanOrEqual(6);
  });

  it("requires a fresh etag and a reason", () => {
    const stale = fail(req({ ifMatch: "0".repeat(64), patch: { merge: { title: "X" } } }), ctx);
    expect(stale.code).toBe("conflict");
    expect(stale.data?.["etag"]).toBe(etag);
    expect(fail(req({ reason: "", patch: { merge: { title: "X" } } }), ctx).code).toBe("invalid-argument");
    expect(fail(req({ reason: "แก้ไข", patch: { merge: { title: "X" } } }), ctx).code).toBe("policy");
  });

  it("reports no change without stamping", () => {
    const plan = planWrite(req({ patch: { merge: { title: parseConcept(text).frontmatter["title"] } } }), ctx);
    expect(plan.changed).toBe(false);
    expect(plan.after).toBe(text);
  });

  it("guards server-owned fields but accepts them unchanged", () => {
    const fm = parseConcept(text).frontmatter;
    expect(fail(req({ patch: { merge: { verified: [{ by: "human:me", at: "2026-10-19T00:00:00Z" }] } } }), ctx).code).toBe("forbidden");
    expect(fail(req({ patch: { merge: { generated: null } } }), ctx).code).toBe("forbidden");
    expect(planWrite(req({ frontmatter: { ...fm, title: "Revenue (recognized)" } }), ctx).changed).toBe(true);
  });

  it("keeps status transitions with people and okf_deprecate", () => {
    const draftFiles = acme();
    draftFiles.set("metrics/revenue.md", text.replace("status: stable", "status: draft"));
    const dctx = ctxFor(draftFiles);
    const dreq = (merge: Record<string, unknown>) => ({ kind: "update" as const, conceptId: "metrics/revenue", ifMatch: etagOf(draftFiles.get("metrics/revenue.md")!), reason: "x", patch: { merge } });
    expect(fail(dreq({ status: "stable" }), dctx).code).toBe("forbidden");
    expect(fail(dreq({ status: null }), dctx).code).toBe("forbidden"); // absent status means stable
    expect(fail(req({ patch: { merge: { status: "deprecated" } } }), ctx).code).toBe("invalid-argument");
    expect(planWrite(req({ patch: { merge: { status: "draft" } } }), ctx).changed).toBe(true);
  });

  it("refuses destructive edits unless allowed", () => {
    const destructive = req({ body: "Short.\n" });
    expect(fail(destructive, ctx).code).toBe("policy");
    expect(fail(req({ patch: { sources_remove: ["revenue-policy"] } }), ctx).code).toBe("policy");
    expect(planWrite({ ...destructive, allowShrink: true } as WriteRequest, ctx).changed).toBe(true);
  });

  it("protects sanctioned computations and raw sources", () => {
    const comp = files.get("computations/revenue-ytd.md")!;
    const creq = (over: object) => ({ kind: "update" as const, conceptId: "computations/revenue-ytd", ifMatch: etagOf(comp), reason: "x", ...over });
    expect(fail(creq({ patch: { merge: { runtime: "postgres" } } }), ctx).code).toBe("forbidden");
    expect(fail(creq({ bodyOps: [{ op: "section_replace", section: ["Computation"], content: "    SELECT 2" }] }), ctx).code).toBe("forbidden");
    expect(planWrite(creq({ patch: { merge: { description: "Recognized revenue, year to date." } } }), ctx).changed).toBe(true);

    const raw = base();
    raw.set("references/raw/r.md", "---\ntype: Raw Source\ntitle: R\nlanguage: th\nresource: https://x\n---\n\nต้นฉบับ\n");
    const rctx = ctxFor(raw);
    const rtext = raw.get("references/raw/r.md")!;
    const rreq = (over: object) => ({ kind: "update" as const, conceptId: "references/raw/r", ifMatch: etagOf(rtext), reason: "x", ...over });
    expect(fail(rreq({ body: "แก้ต้นฉบับ\n" }), rctx).code).toBe("forbidden");
    expect(planWrite(rreq({ patch: { merge: { description: "The original report." } } }), rctx).changed).toBe(true);
  });

  it("keeps reporting a warning that an update did not fix", () => {
    const files = base().set("references/raw/r.md", "---\ntype: Raw Source\ntitle: R\nlanguage: th\nresource: https://x\n---\n\nต้นฉบับ\n");
    const body = "Claim.[^r]\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[^r]: [R](../references/raw/r.md)\n";
    const created = planWrite({ kind: "create", conceptId: "notes/a", frontmatter: { type: "Note", title: "A", sources: [{ id: "r", resource: "/references/raw/r.md" }] }, body }, ctxFor(files));
    expect(created.warnings.join()).toContain("[table-uncited]");
    files.set("notes/a.md", created.after);
    const tried = planWrite({ kind: "update", conceptId: "notes/a", ifMatch: etagOf(created.after), reason: "Cite the table.", body: body.replace("| 1 | 2 |\n", "| 1 | 2 |\n\n[^r]\n") }, ctxFor(files));
    expect(tried.warnings.join()).toContain("[table-uncited]");
    const fixed = planWrite({ kind: "update", conceptId: "notes/a", ifMatch: etagOf(created.after), reason: "Cite the table.", body: body.replace("| 1 | 2 |", "| 1[^r] | 2 |") }, ctxFor(files));
    expect(fixed.warnings.join()).not.toContain("[table-uncited]");
  });

  it("gives a source in a raw directory the original's language unless one is set", () => {
    const raw = base().set("references/raw/r.md", "---\ntype: Raw Source\ntitle: R\nlanguage: th\nresource: https://x\n---\n\nต้นฉบับ\n");
    const sources = [{ id: "r", resource: "references/raw/r.md" }, { id: "s", resource: "/references/raw/r.md", language: "th-TH" }, { id: "w", resource: "https://example.org" }];
    const plan = planWrite({ kind: "create", conceptId: "notes/a", frontmatter: { type: "Note", title: "A", sources }, body: "A claim.[^r][^s][^w]\n\n[^r]: [R](../references/raw/r.md)\n[^s]: S\n[^w]: W\n" }, ctxFor(raw));
    expect(parseConcept(plan.after).frontmatter["sources"]).toEqual([
      { id: "r", resource: "/references/raw/r.md", language: "th" },
      { id: "s", resource: "/references/raw/r.md", language: "th-TH" },
      { id: "w", resource: "https://example.org" },
    ]);
  });

  it("repairs a concept whose YAML is broken only by whole replacement", () => {
    const broken = base();
    broken.set("a.md", "---\ntype: [\n---\n\nBody\n");
    const bctx = ctxFor(broken);
    const r = { kind: "update" as const, conceptId: "a", ifMatch: etagOf(broken.get("a.md")!), reason: "Repair YAML." };
    expect(fail({ ...r, patch: { merge: { type: "Note" } } }, bctx).code).toBe("invalid-argument");
    expect(parseConcept(planWrite({ ...r, frontmatter: { type: "Note" }, body: "Body\n" }, bctx).after).frontmatter["type"]).toBe("Note");
  });
});

describe("ingest_raw", () => {
  const req = (over: Partial<Extract<WriteRequest, { kind: "ingest_raw" }>> = {}): WriteRequest => ({
    kind: "ingest_raw",
    slug: "acme-annual-report-2025",
    title: "ACME Annual Report 2025",
    description: "Converted text of the ACME annual report.",
    language: "th",
    resource: "https://example.org/report-2025.pdf",
    originalTitle: "รายงานประจำปี 2568",
    body: "รายงานประจำปี ดาวเทียมธีออส-2 ถ่ายภาพทุกวัน [[ไม่แปลงลิงก์]]\n",
    ...over,
  });

  it("stores the original verbatim with a content hash", () => {
    const plan = planWrite(req(), ctxFor(base()));
    const { frontmatter, body } = parseConcept(plan.after);
    expect(plan.path).toBe("references/raw/acme-annual-report-2025.md");
    expect(frontmatter).toMatchObject({ type: "Raw Source", language: "th", original_title: "รายงานประจำปี 2568" });
    expect(frontmatter["content_sha256"]).toBe(rawContentHash(body));
    expect(body).toContain("[[ไม่แปลงลิงก์]]");
    expect(lintBundle(analyzeBundle(new Map([...base(), [plan.path, plan.after]]))).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("deduplicates identical content and guards replacement", () => {
    const first = planWrite(req(), ctxFor(base()));
    const files = base();
    files.set(first.path, first.after);
    const ctx = ctxFor(files);
    expect(planWrite(req({ slug: "copy" }), ctx)).toMatchObject({ changed: false, duplicateOf: "references/raw/acme-annual-report-2025" });
    expect(fail(req({ body: "เนื้อหาใหม่\n" }), ctx).code).toBe("exists");
    expect(fail(req({ body: "เนื้อหาใหม่\n", replace: true, ifMatch: etagOf(first.after), reason: "New scan." }), ctx).code).toBe("forbidden");
    expect(planWrite(req({ body: "เนื้อหาใหม่\n", replace: true, ifMatch: etagOf(first.after), reason: "New scan." }), ctxFor(files, ["write", "raw:write"])).changed).toBe(true);
  });

  it("requires English metadata, a language tag and a raw directory", () => {
    expect(fail(req({ title: "รายงาน" }), ctxFor(base())).code).toBe("policy");
    expect(fail(req({ language: "thai" }), ctxFor(base())).code).toBe("invalid-argument");
    expect(fail(req({ dir: "concepts" }), ctxFor(base())).code).toBe("invalid-argument");
  });
});

describe("deprecate and publish", () => {
  it("deprecates with a pointer to the replacement", () => {
    const files = acme();
    const plan = planWrite({ kind: "deprecate", conceptId: "metrics/revenue", replacedBy: "metrics/gross-margin", reason: "Merged into gross margin." }, ctxFor(files));
    const { frontmatter, body } = parseConcept(plan.after);
    expect(frontmatter["status"]).toBe("deprecated");
    expect(body).toContain("> **Deprecated:** superseded by [Gross Margin](gross-margin.md).");
    expect(planWrite({ kind: "deprecate", conceptId: "metrics/gross-margin-legacy", reason: "x" }, ctxFor(files)).changed).toBe(false);
  });

  it("publishes drafts only with the publish scope, without restamping", () => {
    const files = acme();
    const text = files.get("metrics/revenue.md")!.replace("status: stable", "status: draft");
    files.set("metrics/revenue.md", text);
    const r: WriteRequest = { kind: "publish", conceptId: "metrics/revenue", ifMatch: etagOf(text), reason: "Reviewed against policy." };
    expect(fail(r, ctxFor(files)).code).toBe("forbidden");
    const plan = planWrite(r, ctxFor(files, ["write", "publish"]));
    const fm = parseConcept(plan.after).frontmatter;
    expect(fm["status"]).toBe("stable");
    expect(fm["generated"]).toEqual(parseConcept(text).frontmatter["generated"]);
  });
});

describe("human-in-the-loop kinds (Phase 3)", () => {
  const human = (files: Map<string, string>): WriteContext => ({ ...ctxFor(files), actor: "human:ys", can: () => true });
  const draftFiles = () => {
    const f = acme();
    f.set("metrics/revenue.md", f.get("metrics/revenue.md")!.replace("status: stable", "status: draft"));
    return f;
  };

  it("approve: a person verifies, publishes the draft and clears a review request", () => {
    const f = draftFiles();
    f.set("metrics/revenue.md", f.get("metrics/revenue.md")!.replace("status: draft", "status: draft\nreview_requested: { by: claude-code/1, at: 2026-10-18T00:00:00Z, note: Check numbers. }"));
    const plan = planWrite({ kind: "verify", conceptId: "metrics/revenue", approve: true }, human(f));
    const fm = parseConcept(plan.after).frontmatter;
    expect(fm["status"]).toBe("stable");
    expect(fm["review_requested"]).toBeUndefined();
    expect((fm["verified"] as { by: string }[]).at(-1)).toEqual({ by: "human:ys", at: "2026-10-19T08:00:00Z" });
    expect(fm["generated"]).toEqual(parseConcept(f.get("metrics/revenue.md")!).frontmatter["generated"]);
    expect(plan.action).toBe("Approval");
    expect(fail({ kind: "verify", conceptId: "metrics/revenue", approve: true }, ctxFor(f, ["write", "verify"])).code).toBe("forbidden");
    const byProcess = parseConcept(planWrite({ kind: "verify", conceptId: "metrics/revenue", approve: true }, ctxFor(f, ["verify", "publish"])).after).frontmatter;
    expect(byProcess["status"]).toBe("stable");
    expect((byProcess["verified"] as { by: string }[]).at(-1)!.by).toBe(ACTOR);
  });

  it("okf_verify adds a machine verification only with the verify scope", () => {
    expect(fail({ kind: "verify", conceptId: "metrics/revenue" }, ctxFor(acme())).code).toBe("forbidden");
    const plan = planWrite({ kind: "verify", conceptId: "metrics/revenue", note: "Checked against the policy." }, ctxFor(acme(), ["write", "verify"]));
    expect((parseConcept(plan.after).frontmatter["verified"] as { by: string }[]).at(-1)!.by).toBe(ACTOR);
  });

  it("review requests are recorded by the server and cannot be forged through updates", () => {
    const plan = planWrite({ kind: "request_review", conceptId: "metrics/revenue", note: "Numbers changed upstream." }, ctxFor(acme()));
    expect(parseConcept(plan.after).frontmatter["review_requested"]).toEqual({ by: ACTOR, at: "2026-10-19T08:00:00Z", note: "Numbers changed upstream." });
    const t = acme().get("metrics/revenue.md")!;
    expect(fail({ kind: "update", conceptId: "metrics/revenue", ifMatch: etagOf(t), reason: "x", patch: { merge: { review_requested: { by: "human:x" } } } }, ctxFor(acme())).code).toBe("forbidden");
  });

  it("rehash, stamp and convert_links are for people only", () => {
    const raw = base();
    raw.set("references/raw/r.md", "---\ntype: Raw Source\ntitle: R\nlanguage: th\nresource: https://x\ncontent_sha256: abc\n---\n\nต้นฉบับที่แก้แล้ว\n");
    expect(fail({ kind: "rehash", conceptId: "references/raw/r" }, ctxFor(raw)).code).toBe("forbidden");
    const re = parseConcept(planWrite({ kind: "rehash", conceptId: "references/raw/r" }, human(raw)).after);
    expect(re.frontmatter["content_sha256"]).toBe(rawContentHash(re.body));

    const stamped = parseConcept(planWrite({ kind: "stamp", conceptId: "metrics/revenue" }, human(acme())).after).frontmatter;
    expect(stamped["generated"]).toEqual({ by: "human:ys", at: "2026-10-19T08:00:00Z" });
    expect(fail({ kind: "stamp", conceptId: "metrics/revenue" }, ctxFor(acme())).code).toBe("forbidden");

    const conv = planWrite({ kind: "convert_links", conceptId: "policies/margin-standard" }, human(acme()));
    expect(parseConcept(conv.after).body).toContain("](../metrics/gross-margin.md)");
    expect(parseConcept(conv.after).frontmatter["generated"]).toEqual(parseConcept(acme().get("policies/margin-standard.md")!).frontmatter["generated"]);
  });
});
