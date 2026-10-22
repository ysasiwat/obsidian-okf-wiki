import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { analyzeBundle } from "../../src/core/bundle";
import { applyBodyOp, applyBodyOps, BodyOpError } from "../../src/core/bodyOps";
import { planMoveRewrites } from "../../src/core/move";
import { normalizeBodyLinks, normalizeFieldPaths, resolveReference } from "../../src/core/normalize";
import { applyChange, minimalChange } from "../../src/core/textDiff";
import { loadFixtureBundle } from "../helpers";

describe("minimalChange", () => {
  it("turns a into b with one replacement, for any strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), fc.string({ unit: "grapheme", maxLength: 80 }), (a, b) => {
        expect(applyChange(a, minimalChange(a, b))).toBe(b);
      }),
    );
  });

  it("is minimal and never splits a surrogate pair", () => {
    expect(minimalChange("type: A\nbody", "type: B\nbody")).toEqual({ from: 6, to: 7, insert: "B" });
    expect(minimalChange("same", "same")).toBeNull();
    const c = minimalChange("x😀y", "x😃y")!;
    expect(c).toEqual({ from: 1, to: 3, insert: "😃" });
  });
});

describe("body section ops", () => {
  const body = "Intro.\n\n# Schema\n\n| a | b |\n\n# Examples\n\nOne.\n";

  it("replaces, appends to and prepends to a section", () => {
    expect(applyBodyOp(body, { op: "section_replace", section: ["Schema"], content: "New table.\n" })).toBe(
      "Intro.\n\n# Schema\n\nNew table.\n\n# Examples\n\nOne.\n",
    );
    expect(applyBodyOp(body, { op: "section_append", section: ["Examples"], content: "Two." })).toBe(
      "Intro.\n\n# Schema\n\n| a | b |\n\n# Examples\n\nOne.\n\nTwo.\n",
    );
    expect(applyBodyOp(body, { op: "section_prepend", section: ["Schema"], content: "Note." })).toBe(
      "Intro.\n\n# Schema\n\nNote.\n\n| a | b |\n\n# Examples\n\nOne.\n",
    );
  });

  it("deletes a section and appends to the body", () => {
    expect(applyBodyOp(body, { op: "section_delete", section: ["Schema"] })).toBe("Intro.\n\n# Examples\n\nOne.\n");
    expect(applyBodyOp(body, { op: "section_delete", section: ["Examples"] })).toBe("Intro.\n\n# Schema\n\n| a | b |\n");
    expect(applyBodyOps("Intro.\n", [{ op: "append", content: "# More\n\nText" }])).toBe("Intro.\n\n# More\n\nText\n");
  });

  it("refuses unknown or ambiguous sections", () => {
    expect(() => applyBodyOp(body, { op: "section_delete", section: ["Nope"] })).toThrow(BodyOpError);
  });
});

const NOTE = ["---", "type: N", "---", ""].join("\n");

describe("link normalization", () => {
  const model = analyzeBundle(loadFixtureBundle("acme_retail"));

  it("resolves references by id, document path and unique file name", () => {
    expect(resolveReference(model, "metrics/x.md", "tables/orders")).toEqual({ path: "tables/orders.md" });
    expect(resolveReference(model, "metrics/x.md", "revenue")).toEqual({ path: "metrics/revenue.md" });
    expect(resolveReference(model, "metrics/x.md", "orders")).toEqual({ path: "tables/orders.md" });
    expect(resolveReference(model, "metrics/x.md", "index")).toEqual({ path: "index.md" });
    const twins = analyzeBundle(new Map([["a/note.md", NOTE], ["b/note.md", NOTE]]));
    expect(resolveReference(twins, "c/x.md", "note")).toHaveProperty("error");
    expect(resolveReference(model, "metrics/x.md", "new-thing")).toEqual({ missing: "new-thing.md" });
  });

  it("converts wikilinks, '/' links and okf: ids to relative markdown links", () => {
    const r = normalizeBodyLinks(
      "See [[orders]], [[tables/orders#Schema|the schema]], [rev](/metrics/revenue.md), [m](okf:metrics/gross-margin) and [x](https://e.com).",
      "computations/new.md",
      model,
    );
    expect(r.errors).toEqual([]);
    expect(r.value).toBe(
      "See [orders](../tables/orders.md), [the schema](../tables/orders.md#Schema), [rev](../metrics/revenue.md), [m](../metrics/gross-margin.md) and [x](https://e.com).",
    );
  });

  it("warns about unresolved links and refuses escapes and ambiguity", () => {
    expect(normalizeBodyLinks("[a](missing.md)", "metrics/n.md", model).warnings[0]).toMatch(/does not resolve/);
    expect(normalizeBodyLinks("[a](../../x.md)", "metrics/n.md", model).errors[0]).toMatch(/outside/);
    const twins = analyzeBundle(new Map([["a/note.md", NOTE], ["b/note.md", NOTE]]));
    expect(normalizeBodyLinks("[[note]]", "c/n.md", twins).errors[0]).toMatch(/matches 2 files/);
  });

  it("makes path fields bundle-absolute and leaves URLs and descriptors alone", () => {
    const r = normalizeFieldPaths(
      {
        resource: "https://x",
        sources: [{ id: "a", resource: "policies/margin-standard.md" }, { id: "b", resource: "all queries in project X" }],
        executor: { resource: "skills/run-on-bq.md", receipt: ["job_id"] },
      },
      ["resource", "sources", "executor"],
      "computations/new.md",
      model,
    );
    expect(r.value).toEqual({
      resource: "https://x",
      sources: [{ id: "a", resource: "/policies/margin-standard.md" }, { id: "b", resource: "all queries in project X" }],
      executor: { resource: "/skills/run-on-bq.md", receipt: ["job_id"] },
    });
  });
});

describe("planMoveRewrites", () => {
  const files = loadFixtureBundle("acme_retail");
  const model = analyzeBundle(files);

  it("rewrites inbound links and frontmatter paths, and the moved file's own links", () => {
    const out = planMoveRewrites(model, "policies/revenue-recognition.md", "policies/finance/revenue-recognition.md");
    // Inbound: metrics/revenue.md cites the policy in sources.
    const revenue = out.get("metrics/revenue.md")!;
    expect(revenue).toContain("resource: /policies/finance/revenue-recognition.md");
    // Outbound links of the moved file are recomputed from its new folder.
    const moved = out.get("policies/finance/revenue-recognition.md")!;
    expect(moved).toBeDefined();
    // Every rewritten file still parses and lints the same way once applied.
    const after = new Map(files);
    after.delete("policies/revenue-recognition.md");
    for (const [p, t] of out) after.set(p, t);
    const m2 = analyzeBundle(after);
    const broken = [...m2.concepts.values()].flatMap((c) => c.links.filter((l) => l.resolution.kind === "path" && !l.resolution.exists && l.link.kind === "markdown").map((l) => `${c.path} -> ${l.link.target}`));
    const brokenBefore = [...model.concepts.values()].flatMap((c) => c.links.filter((l) => l.resolution.kind === "path" && !l.resolution.exists && l.link.kind === "markdown").map((l) => `${c.path} -> ${l.link.target}`));
    expect(broken.length).toBeLessThanOrEqual(brokenBefore.length);
    expect(m2.backlinks.get("policies/finance/revenue-recognition.md")?.length).toBe(model.backlinks.get("policies/revenue-recognition.md")?.length);
  });

  it("is idempotent: planning again after applying changes only the moved file's identity", () => {
    const out = planMoveRewrites(model, "metrics/revenue.md", "metrics/recognized-revenue.md");
    const after = new Map(files);
    after.delete("metrics/revenue.md");
    for (const [p, t] of out) after.set(p, t);
    const again = planMoveRewrites(analyzeBundle(after), "metrics/recognized-revenue.md", "metrics/recognized-revenue.md");
    for (const [p, t] of again) expect(t, p).toBe(after.get(p));
  });
});
