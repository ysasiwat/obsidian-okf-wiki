import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { analyzeBundle, analyzeBundleSliced, isHiddenPath } from "../../src/core/bundle";
import { lintBundle } from "../../src/core/lint";
import { loadFixtureBundle } from "../helpers";

// Paths and texts that link to each other, so an edit can make another file's link resolve or break.
const PATHS = ["a.md", "d/b.md", "d/c.md", "references/raw/r.md", "d/index.md", "log.md", "notes.txt"];
const TEXTS = [
  "---\ntype: Note\ntitle: A\n---\n\nSee [b](d/b.md) and [[c]].\n",
  "---\ntype: Note\nsources:\n  - { id: r, resource: /references/raw/r.md }\n---\n\nClaim.[^r]\n\n| x |\n|---|\n| 1 |\n\n[^r]: [R](../references/raw/r.md)\n",
  "---\ntype: Raw Source\nlanguage: th\nresource: x\n---\n\nต้นฉบับ\n",
  "---\ntype: [\n---\n",
  "# No frontmatter, link to [a](../a.md)\n",
  "plain text",
  "---\ntype: Note\nstale_after: 2026-06-01T00:00:00Z\n---\n\nSee [[a]] and [x](/d/b.md).\n",
];
const NOWS = [new Date("2026-01-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z")];
const POLICIES = ['okf_version: "0.2"\n', 'okf_version: "0.2"\nraw_dirs: [d]\n', "auto_index: maybe\n"];

const edit = fc.oneof(
  fc.record({ path: fc.constantFrom(...PATHS), text: fc.option(fc.constantFrom(...TEXTS), { nil: null }) }),
  fc.record({ path: fc.constant(".okf.yaml"), text: fc.option(fc.constantFrom(...POLICIES), { nil: null }) }),
);

describe("analyzeBundle with a previous model", () => {
  it("equals a fresh analysis after any sequence of edits", () => {
    fc.assert(
      fc.property(fc.array(fc.array(edit, { maxLength: 4 }), { minLength: 1, maxLength: 6 }), (steps) => {
        let files = loadFixtureBundle("acme_retail");
        let model = analyzeBundle(files);
        for (const step of steps) {
          files = new Map(files);
          for (const { path, text } of step) {
            if (text === null) files.delete(path);
            else files.set(path, text);
          }
          model = analyzeBundle(files, model);
          expect(model).toEqual(analyzeBundle(files));
        }
      }),
      { numRuns: 80 },
    );
  }, 60_000);

  it("gives the same lint as a fresh analysis, with per-concept results reused", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.array(edit, { maxLength: 4 }), fc.constantFrom(...NOWS)), { minLength: 1, maxLength: 6 }), (steps) => {
        let files = loadFixtureBundle("acme_retail");
        let model = analyzeBundle(files);
        lintBundle(model, { now: NOWS[0] });
        for (const [step, now] of steps) {
          files = new Map(files);
          for (const { path, text } of step) {
            if (text === null) files.delete(path);
            else files.set(path, text);
          }
          model = analyzeBundle(files, model);
          expect(lintBundle(model, { now })).toEqual(lintBundle(analyzeBundle(files), { now }));
        }
      }),
      { numRuns: 80 },
    );
  }, 60_000);

  it("re-lints a concept whose source target changed zone though the concept did not", () => {
    const files = new Map([
      [".okf.yaml", 'okf_version: "0.2"\n'],
      ["references/raw/r.md", TEXTS[2]!],
      ["a.md", "---\ntype: Note\nsources:\n  - { id: r, resource: /references/raw/r.md }\n---\n\n| x |\n|---|\n| 1 |\n"],
    ]);
    const first = analyzeBundle(files);
    expect(lintBundle(first).map((d) => d.code)).toContain("table-uncited");
    const moved = new Map(files).set(".okf.yaml", 'okf_version: "0.2"\nraw_dirs: [elsewhere]\n');
    expect(lintBundle(analyzeBundle(moved, first)).map((d) => d.code)).not.toContain("table-uncited");
  });

  it("analyzeBundleSliced gives the same model and hands control back between files", async () => {
    const files = loadFixtureBundle("acme_retail");
    let pauses = 0;
    const sliced = await analyzeBundleSliced(files, undefined, async () => void pauses++, 0);
    expect(sliced).toEqual(analyzeBundle(files));
    expect(pauses).toBe(sliced.concepts.size);
    const changed = new Map(files).set("a.md", TEXTS[0]!);
    expect(await analyzeBundleSliced(changed, sliced, async () => undefined)).toEqual(analyzeBundle(changed));
  });

  it("isHiddenPath matches 'some segment starts with a dot'", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z.]{0,4}$/), { minLength: 1, maxLength: 4 }), (segs) => {
        expect(isHiddenPath(segs.join("/"))).toBe(segs.some((s) => s.startsWith(".")));
      }),
    );
  });

  it("reuses the parse of unchanged files", () => {
    const files = loadFixtureBundle("acme_retail");
    const first = analyzeBundle(files);
    const changed = new Map(files).set("metrics/revenue.md", files.get("metrics/revenue.md")!.replace("Revenue", "Revenues"));
    const second = analyzeBundle(changed, first);
    expect(second.concepts.get("tables/orders.md")!.frontmatter).toBe(first.concepts.get("tables/orders.md")!.frontmatter);
    expect(second.concepts.get("metrics/revenue.md")!.frontmatter).not.toBe(first.concepts.get("metrics/revenue.md")!.frontmatter);
  });
});
