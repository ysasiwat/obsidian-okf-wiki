import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeBundle } from "../../src/core/bundle";
import { editConcept, renderNewConcept } from "../../src/core/edit";
import { renderAllIndexes } from "../../src/core/indexRender";
import { appendLogEntries, logProblems, utcDate, type LogEntry } from "../../src/core/logRender";
import { applyFrontmatterPatch, mergePatch } from "../../src/core/patch";
import { upsertSources } from "../../src/core/sources";
import { normalizeTags } from "../../src/core/tags";

describe("index rendering", () => {
  it("renders the OKF §8 format with type sections, drafts marked, and okf_version kept", () => {
    const files = new Map<string, string>([
      [".okf.yaml", "okf_version: \"0.2\"\n"],
      ["concepts/b.md", "---\ntype: Metric\ntitle: Beta\ndescription: Second.\nstatus: draft\n---\n"],
      ["concepts/a.md", "---\ntype: Metric\ntitle: Alpha [v2]\ndescription: First\n  continued.\n---\n"],
      ["concepts/old.md", "---\ntype: Metric\ntitle: Old\nstatus: deprecated\n---\n"],
      ["concepts/p.md", "---\ntype: Playbook\ntitle: Runbook 10\n---\n"],
    ]);
    const idx = renderAllIndexes(analyzeBundle(files));
    expect(idx.get("index.md")).toBe(
      "---\nokf_version: \"0.2\"\n---\n\n# Subdirectories\n\n* [concepts](concepts/index.md) - 4 concepts: Metric, Playbook\n",
    );
    expect(idx.get("concepts/index.md")).toBe(
      [
        "# Metric",
        "",
        "* [Alpha \\[v2\\]](a.md) - First continued.",
        "* [Beta (draft)](b.md) - Second.",
        "",
        "# Playbook",
        "",
        "* [Runbook 10](p.md)",
        "",
        "# Deprecated concepts",
        "",
        "* [Old](old.md)",
        "",
      ].join("\n"),
    );
  });
});

describe("log maintenance", () => {
  const e = (over: Partial<LogEntry>): LogEntry => ({
    date: "2026-10-14", action: "Update", title: "Revenue", link: "metrics/revenue.md", actor: "claude-code/opus", ...over,
  });

  it("creates a log, groups by day newest first, and coalesces repeats", () => {
    let log = appendLogEntries(undefined, [e({ date: "2026-10-13", action: "Creation", reason: "first draft" })]);
    log = appendLogEntries(log, [e({ reason: "added sources" })]);
    log = appendLogEntries(log, [e({ reason: "fixed typo" }), e({ title: "Margin", link: "metrics/margin.md" })]);
    expect(log).toBe(
      [
        "# Bundle Update Log",
        "",
        "## 2026-10-14",
        "",
        "* **Update**: [Revenue](metrics/revenue.md) - added sources; fixed typo (by claude-code/opus)",
        "* **Update**: [Margin](metrics/margin.md) (by claude-code/opus)",
        "",
        "## 2026-10-13",
        "",
        "* **Creation**: [Revenue](metrics/revenue.md) - first draft (by claude-code/opus)",
        "",
      ].join("\n"),
    );
    expect(logProblems(log)).toEqual([]);
  });

  it("preserves hand-written lines and an older day's place", () => {
    const existing = "# History\n\n## 2026-10-01\n\n* **Initialization**: Created the bundle.\n";
    const out = appendLogEntries(existing, [e({})]);
    expect(out).toBe(
      "# History\n\n## 2026-10-14\n\n* **Update**: [Revenue](metrics/revenue.md) (by claude-code/opus)\n\n## 2026-10-01\n\n* **Initialization**: Created the bundle.\n",
    );
  });

  it("appends to the acme sample log without disturbing it", () => {
    const acme = readFileSync(join(__dirname, "..", "fixtures", "okf-bundles", "acme_retail", "log.md"), "utf8");
    const out = appendLogEntries(acme, [e({ date: "2026-07-01", action: "Verification" })]);
    expect(out.startsWith(acme.replace(/\n+$/, "").split("## 2026-06-30")[0]!.replace(/\n+$/, ""))).toBe(true);
    expect(out).toContain("* **Verification**: [Revenue](metrics/revenue.md) (by claude-code/opus)\n\n## 2026-06-30");
  });

  it("uses UTC dates", () => {
    expect(utcDate(new Date("2026-10-14T23:30:00-07:00"))).toBe("2026-10-15");
  });
});

describe("frontmatter patches", () => {
  it("implements RFC 7386 merge patch", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { a: null, b: { c: 9 }, e: [1] })).toEqual({ b: { c: 9, d: 3 }, e: [1] });
  });

  it("upserts sources by id and never drops existing entries", () => {
    const next = applyFrontmatterPatch(
      { sources: [{ id: "a", resource: "x" }, { resource: "y" }] },
      { sources_upsert: [{ id: "a", resource: "x2" }, { id: "b", resource: "z" }, { resource: "y", title: "Y" }] },
    );
    expect(next["sources"]).toEqual([{ id: "a", resource: "x2" }, { resource: "y", title: "Y" }, { id: "b", resource: "z" }]);
    expect(upsertSources([], [])).toEqual([]);
  });

  it("adds and removes tags, reading comma-string tags", () => {
    expect(applyFrontmatterPatch({ tags: "a, b" }, { tags_add: ["c", "a"], tags_remove: ["b"] })["tags"]).toEqual(["a", "c"]);
    expect(normalizeTags({ tags: ["x", 2, null] })).toEqual(["x", "2"]);
  });
});

describe("editConcept", () => {
  it("keeps CRLF, untouched keys and the body when only one key changes", () => {
    const text = "---\r\ntype: Metric\r\ntags: [a, b]\r\ngenerated: { by: x/1, at: 2026-01-01T00:00:00Z }\r\n---\r\n\r\nBody [^s]\r\n";
    const out = editConcept(text, { frontmatter: { type: "Metric", tags: ["a", "b"], generated: { by: "x/1", at: "2026-10-14T00:00:00Z" } } });
    expect(out).toBe(text.replace("2026-01-01T00:00:00Z", "2026-10-14T00:00:00Z"));
  });

  it("renders new concepts with a blank line after the frontmatter", () => {
    expect(renderNewConcept({ title: "T", type: "Note" }, "Hello")).toBe("---\ntype: Note\ntitle: T\n---\n\nHello\n");
  });
});

describe("okf-core purity", () => {
  it("imports neither obsidian nor node built-ins", () => {
    const dir = join(__dirname, "..", "..", "src", "core");
    const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'](obsidian|node:[^"']+|fs|path|crypto)["']/);
    }
  });
});
