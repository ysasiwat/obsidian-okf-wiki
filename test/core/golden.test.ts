// Golden tests against the OKF sample bundles (test/fixtures/okf-bundles, upstream
// commit ad30107). See DESIGN.md §12 item 1.

import { describe, expect, it } from "vitest";
import { analyzeBundle } from "../../src/core/bundle";
import { parseIndexEntries, renderAllIndexes } from "../../src/core/indexRender";
import { countBySeverity, lintBundle } from "../../src/core/lint";
import { trustTier } from "../../src/core/trust";
import { BUNDLE_NAMES, loadFixtureBundle } from "../helpers";

const NOW = new Date("2026-10-14T00:00:00Z");

describe.each(BUNDLE_NAMES)("sample bundle %s", (name) => {
  const files = loadFixtureBundle(name);
  const model = analyzeBundle(files);

  it("is conformant: lint reports no errors", () => {
    const diagnostics = lintBundle(model, { now: NOW });
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("parses every concept with a type", () => {
    for (const c of model.concepts.values()) {
      expect(c.parseError, c.path).toBeNull();
      expect(c.type, c.path).not.toBeNull();
    }
  });

  it("regenerated indexes list exactly the entries of the originals", () => {
    const rendered = renderAllIndexes(model);
    for (const [path, original] of model.reserved) {
      if (!path.endsWith("index.md")) continue;
      const want = [...parseIndexEntries(original).keys()].sort();
      const got = [...parseIndexEntries(rendered.get(path) ?? "").keys()].sort();
      expect(got, path).toEqual(want);
    }
    // And no index appears where the original bundle had none.
    for (const path of rendered.keys()) expect(model.reserved.has(path), path).toBe(true);
  });

  it("keeps the existing subdirectory descriptions", () => {
    const rendered = renderAllIndexes(model);
    for (const [path, original] of model.reserved) {
      if (!path.endsWith("index.md")) continue;
      const before = parseIndexEntries(original);
      const after = parseIndexEntries(rendered.get(path)!);
      for (const [link, desc] of before) {
        if (link.endsWith("/index.md") && desc) expect(after.get(link), `${path} ${link}`).toBe(desc);
      }
    }
  });

  it("is deterministic", () => {
    const a = renderAllIndexes(analyzeBundle(files));
    const b = renderAllIndexes(analyzeBundle(new Map([...files].reverse())));
    expect([...a]).toEqual([...b]);
  });
});

describe("acme_retail specifics", () => {
  const model = analyzeBundle(loadFixtureBundle("acme_retail"));

  it("derives the documented trust tiers", () => {
    expect(trustTier(model.concepts.get("metrics/gross-margin.md")!.frontmatter)).toBe("human-reviewed");
  });

  it("resolves bundle-relative frontmatter paths as edges", () => {
    const comp = model.concepts.get("computations/revenue-ytd.md")!;
    const executor = comp.fieldPaths.find((f) => f.field === "executor.resource")!;
    expect(executor.target).toBe("skills/run-on-bq.md");
    const cited = (model.backlinks.get("policies/revenue-recognition.md") ?? []).map((e) => `${e.from}:${e.kind}`);
    expect(cited).toContain("computations/revenue-ytd.md:source");
  });

  it("lists deprecated concepts in their own section", () => {
    const index = renderAllIndexes(model).get("metrics/index.md")!;
    expect(index).toMatch(/# Deprecated concepts\n\n\* \[Gross Margin \(legacy, pre-FY2026\)\]\(gross-margin-legacy\.md\)/);
  });

  it("flags the log.md frontmatter and the '/' links, nothing else above info", () => {
    const counts = countBySeverity(lintBundle(model, { now: NOW }));
    expect(counts.error).toBe(0);
    const codes = new Set(lintBundle(model, { now: NOW }).filter((d) => d.severity === "warning").map((d) => d.code));
    expect([...codes].sort()).toEqual(["absolute-link", "log-format"]);
  });
});
