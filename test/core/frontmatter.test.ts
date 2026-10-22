import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { joinConcept, parseConcept, parseFrontmatter, splitConcept } from "../../src/core/document";
import { renderFrontmatter, renderKey, updateFrontmatterText } from "../../src/core/frontmatter";
import { listFixtureConcepts, fixturePath } from "../helpers";

describe("splitConcept / joinConcept", () => {
  it("round-trips every fixture byte for byte", () => {
    for (const rel of listFixtureConcepts()) {
      const text = readFileSync(fixturePath(rel), "utf8");
      expect(joinConcept(splitConcept(text)), rel).toBe(text);
    }
  });

  it("keeps CRLF line endings and a BOM", () => {
    const text = "﻿---\r\ntype: Metric\r\n---\r\n\r\n# Body\r\n";
    const parts = splitConcept(text);
    expect(parts.eol).toBe("\r\n");
    expect(parts.bom).toBe(true);
    expect(parts.frontmatterText).toBe("type: Metric\n");
    expect(parts.body).toBe("\n# Body\n");
    expect(joinConcept(parts)).toBe(text);
  });

  it("treats mixed line endings as LF and preserves stray CRs", () => {
    const text = "---\ntype: A\r\n---\nbody\n";
    expect(joinConcept(splitConcept(text))).toBe(text);
  });

  it("handles documents without frontmatter or without a closing newline", () => {
    for (const text of ["# Just a body\n", "", "---\ntype: A\n---", "---\n---\nbody"]) {
      expect(joinConcept(splitConcept(text))).toBe(text);
    }
  });

  it("reports unterminated frontmatter", () => {
    expect(splitConcept("---\ntype: A\nbody\n").unterminated).toBe(true);
    expect(() => parseConcept("---\ntype: A\n")).toThrow(/Unterminated/);
  });
});

describe("parseFrontmatter", () => {
  it("keeps timestamps and dates as strings (YAML 1.2 core)", () => {
    const fm = parseFrontmatter("at: 2026-06-30T14:00:00Z\nd: 2026-12-31\nv: \"0.2\"\n");
    expect(fm).toEqual({ at: "2026-06-30T14:00:00Z", d: "2026-12-31", v: "0.2" });
  });

  it("rejects non-mappings, bad YAML and duplicate keys", () => {
    expect(() => parseFrontmatter("- a\n- b\n")).toThrow(/mapping/);
    expect(() => parseFrontmatter("a: [1\n")).toThrow(/Invalid YAML/);
    expect(() => parseFrontmatter("a: 1\na: 2\n")).toThrow(/Invalid YAML/);
  });
});

describe("renderKey", () => {
  it("follows the OKF samples' flow conventions", () => {
    expect(renderKey("tags", ["finance", "revenue"])).toBe("tags: [finance, revenue]\n");
    expect(renderKey("generated", { by: "agent/v1", at: "2026-06-30T14:00:00Z" })).toBe(
      "generated: { by: agent/v1, at: 2026-06-30T14:00:00Z }\n",
    );
    expect(renderKey("verified", [{ by: "human:ys", at: "2026-07-01T09:00:00Z" }])).toBe(
      "verified:\n  - { by: human:ys, at: 2026-07-01T09:00:00Z }\n",
    );
    expect(
      renderKey("sources", [{ id: "a", resource: "/references/raw/a.md", title: "A" }]),
    ).toBe("sources:\n  - id: a\n    resource: /references/raw/a.md\n    title: A\n");
    expect(renderKey("okf_version", "0.2")).toBe('okf_version: "0.2"\n');
  });

  it("does not fold long lines", () => {
    const long = "word ".repeat(60).trim();
    expect(renderKey("description", long)).toBe(`description: ${long}\n`);
  });
});

describe("updateFrontmatterText", () => {
  it("confines a one-key edit to that key's lines on every fixture", () => {
    for (const rel of listFixtureConcepts()) {
      const parts = splitConcept(readFileSync(fixturePath(rel), "utf8"));
      if (parts.frontmatterText === null) continue;
      const fm = parseFrontmatter(parts.frontmatterText);
      const key = "title" in fm ? "title" : "type";
      const out = updateFrontmatterText(parts.frontmatterText, fm, { ...fm, [key]: "Edited" });
      const before = parts.frontmatterText.split("\n");
      const after = out.split("\n");
      expect(after.length, rel).toBe(before.length);
      const changed = before.filter((line, i) => after[i] !== line);
      expect(changed.length, rel).toBe(1);
      expect(parseFrontmatter(out)).toEqual({ ...fm, [key]: "Edited" });
    }
  });

  it("returns identical text when nothing changed, even with reordered nested keys", () => {
    const text = "type: A\ngenerated: { by: x/1, at: 2026-01-01T00:00:00Z }\n";
    const fm = parseFrontmatter(text);
    const reordered = { type: "A", generated: { at: "2026-01-01T00:00:00Z", by: "x/1" } };
    expect(updateFrontmatterText(text, fm, reordered)).toBe(text);
  });

  it("inserts new keys at their preferred position", () => {
    const text = "type: Metric\ntitle: Revenue\nsources:\n  - id: a\n    resource: x\n";
    const fm = parseFrontmatter(text);
    const out = updateFrontmatterText(text, fm, {
      ...fm,
      status: "draft",
      generated: { by: "agent/1", at: "2026-10-14T00:00:00Z" },
      custom_key: 1,
    });
    expect(out).toBe(
      "type: Metric\ntitle: Revenue\nstatus: draft\n" +
        "generated: { by: agent/1, at: 2026-10-14T00:00:00Z }\n" +
        "sources:\n  - id: a\n    resource: x\ncustom_key: 1\n",
    );
  });

  it("removes keys and keeps comments and blank lines between keys", () => {
    const text = "type: A\n# about tags\ntags: [a]\n\ntitle: T\n";
    const fm = parseFrontmatter(text);
    const { title: _t, ...rest } = fm;
    expect(updateFrontmatterText(text, fm, { ...rest, tags: ["a", "b"] })).toBe(
      "type: A\n# about tags\ntags: [a, b]\n\n",
    );
  });

  it("returns the input untouched when nothing changed, even without a final newline", () => {
    const text = "type: A\ntitle: T";
    expect(updateFrontmatterText(text, parseFrontmatter(text), { type: "A", title: "T" })).toBe(text);
  });

  it("treats undefined values as removal", () => {
    const text = "type: A\ntitle: T\n";
    expect(updateFrontmatterText(text, parseFrontmatter(text), { type: "A", title: undefined, x: undefined })).toBe("type: A\n");
  });

  // The frontmatter Obsidian's Properties UI wrote in spike S4 (ADR 0003).
  const OBSIDIAN_STYLE = [
    "type: Metric",
    "title: Gross Margin v2",
    "tags:",
    "  - finance",
    "  - margin",
    "generated:",
    "  by: reference_agent/gemini-2.5-pro",
    "  at: 2026-06-30T14:00:00Z",
    "verified:",
    "  - by: human:jsmith",
    "    at: 2026-07-01T09:00:00Z",
    "",
  ].join("\n");

  it("keeps Obsidian's block style for re-rendered and new keys", () => {
    const fm = parseFrontmatter(OBSIDIAN_STYLE);
    const out = updateFrontmatterText(OBSIDIAN_STYLE, fm, {
      ...fm,
      tags: ["finance", "margin", "test"],
      generated: { by: "claude-code/opus", at: "2026-10-19T00:00:00Z" },
      aliases: ["กำไรขั้นต้น"],
    });
    expect(out).toBe(
      [
        "type: Metric",
        "title: Gross Margin v2",
        "tags:",
        "  - finance",
        "  - margin",
        "  - test",
        "aliases:",
        "  - กำไรขั้นต้น",
        "generated:",
        "  by: claude-code/opus",
        "  at: 2026-10-19T00:00:00Z",
        "verified:",
        "  - by: human:jsmith",
        "    at: 2026-07-01T09:00:00Z",
        "",
      ].join("\n"),
    );
  });

  it("keeps OKF flow style where the document uses it, per key", () => {
    const text = "type: A\ntags: [a]\nsources:\n  - id: s\n    resource: x\n";
    const fm = parseFrontmatter(text);
    const out = updateFrontmatterText(text, fm, { ...fm, tags: ["a", "b"], generated: { by: "x/1", at: "2026-10-19T00:00:00Z" } });
    expect(out).toBe("type: A\ntags: [a, b]\ngenerated: { by: x/1, at: 2026-10-19T00:00:00Z }\nsources:\n  - id: s\n    resource: x\n");
  });

  it("uses OKF style for a document of scalars only", () => {
    const text = "type: A\n";
    expect(updateFrontmatterText(text, parseFrontmatter(text), { type: "A", tags: ["x"] })).toBe("type: A\ntags: [x]\n");
  });

  it("falls back to a full render for a flow-mapping frontmatter", () => {
    const text = "{ type: A, title: T }\n";
    const fm = parseFrontmatter(text);
    expect(updateFrontmatterText(text, fm, { ...fm, title: "U" })).toBe("type: A\ntitle: U\n");
  });
});

describe("renderFrontmatter", () => {
  it("orders keys for new documents", () => {
    expect(
      renderFrontmatter({ zeta: 1, tags: ["a"], type: "Metric", title: "T" }),
    ).toBe("type: Metric\ntitle: T\ntags: [a]\nzeta: 1\n");
  });
});
