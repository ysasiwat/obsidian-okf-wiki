// One case per lint rule: the codes are a contract the MCP layer and agents rely on.

import { describe, expect, it } from "vitest";
import { analyzeBundle } from "../../src/core/bundle";
import { lintBundle } from "../../src/core/lint";
import { parsePolicy } from "../../src/core/policy";

const NOW = new Date("2026-10-14T00:00:00Z");
const doc = (fm: string, body = "Body.\n") => `---\n${fm}---\n\n${body}`;

function codesFor(files: Record<string, string>): string[] {
  return lintBundle(analyzeBundle(new Map(Object.entries(files))), { now: NOW }).map((d) => `${d.severity}:${d.code}:${d.path}`);
}

const cases: [string, Record<string, string>, string][] = [
  ["invalid YAML", { "a.md": "---\ntype: [\n---\n" }, "error:invalid-frontmatter:a.md"],
  ["unterminated frontmatter", { "a.md": "---\ntype: A\n" }, "error:invalid-frontmatter:a.md"],
  ["no frontmatter", { "a.md": "# Hi\n" }, "error:missing-frontmatter:a.md"],
  ["no type", { "a.md": doc("title: A\n") }, "error:missing-type:a.md"],
  ["non-portable id", { "My Note.md": doc("type: Note\n") }, "info:nonportable-id:My Note.md"],
  ["multiline description", { "a.md": doc("type: N\ndescription: |\n  one\n  two\n") }, "warning:description-multiline:a.md"],
  ["long description", { "a.md": doc(`type: N\ndescription: ${"x".repeat(201)}\n`) }, "warning:description-too-long:a.md"],
  ["string tags", { "a.md": doc("type: N\ntags: a, b\n") }, "warning:tag-format:a.md"],
  ["bad tags", { "a.md": doc("type: N\ntags: [Remote Sensing, '2026']\n") }, "warning:tag-invalid:a.md"],
  ["unknown status", { "a.md": doc("type: N\nstatus: retired\n") }, "warning:status-invalid:a.md"],
  ["date-only stale_after", { "a.md": doc("type: N\nstale_after: 2026-12-31\n") }, "warning:timestamp-invalid:a.md"],
  ["stale", { "a.md": doc("type: N\nstale_after: 2026-01-01T00:00:00Z\n") }, "info:stale:a.md"],
  ["generated not a mapping", { "a.md": doc("type: N\ngenerated: yesterday\n") }, "warning:generated-invalid:a.md"],
  ["bad generated actor", { "a.md": doc("type: N\ngenerated: { by: someone, at: 2026-01-01T00:00:00Z }\n") }, "warning:actor-invalid:a.md"],
  ["bad generated.at", { "a.md": doc("type: N\ngenerated: { by: a/1, at: soon }\n") }, "warning:timestamp-invalid:a.md"],
  ["bad verified", { "a.md": doc("type: N\nverified: { by: bob, at: never }\n") }, "warning:actor-invalid:a.md"],
  ["source without resource", { "a.md": doc("type: N\nsources:\n  - id: s\n") }, "warning:source-missing-resource:a.md"],
  ["duplicate source ids", { "a.md": doc("type: N\nsources:\n  - { id: s, resource: x }\n  - { id: s, resource: y }\n") }, "warning:source-duplicate-id:a.md"],
  ["dangling footnote", { "a.md": doc("type: N\n", "Claim.[^x]\n") }, "warning:footnote-dangling:a.md"],
  ["uncited source", { "a.md": doc("type: N\nsources:\n  - { id: s, resource: x }\n  - { id: t, resource: y }\n", "C.[^s]\n\n[^s]: S\n") }, "info:source-uncited:a.md"],
  ["wikilink", { "a.md": doc("type: N\n", "See [[b]].\n"), "b.md": doc("type: N\n") }, "warning:wikilink:a.md"],
  ["link outside bundle", { "a.md": doc("type: N\n", "[x](../../x.md)\n") }, "warning:link-outside-bundle:a.md"],
  ["broken link with filename match", { "d/a.md": doc("type: N\n", "[x](b.md)\n"), "e/b.md": doc("type: N\n") }, "info:broken-link:d/a.md"],
  ["absolute link", { "a.md": doc("type: N\n", "[x](/b.md)\n"), "b.md": doc("type: N\n") }, "warning:absolute-link:a.md"],
  ["ambiguous field path", { "c/a.md": doc("type: N\nresource: s/x.md\n"), "s/x.md": doc("type: N\n"), "c/s/x.md": doc("type: N\n") }, "warning:path-ambiguous:c/a.md"],
  ["broken field path", { "a.md": doc("type: N\nresource: nowhere/x.md\n") }, "info:path-broken:a.md"],
  ["field path outside", { "a.md": doc("type: N\nresource: ../../x.md\n") }, "warning:path-outside-bundle:a.md"],
  ["computation without runtime", { "a.md": doc("type: Attested Computation\n") }, "warning:computation-missing-runtime:a.md"],
  ["Thai title", { "a.md": doc("type: N\ntitle: ดาวเทียม\n") }, "error:language-not-english:a.md"],
  ["raw without hash", { "references/raw/r.md": doc("type: Raw Source\nlanguage: th\nresource: x\n") }, "warning:raw-hash-missing:references/raw/r.md"],
  ["raw without resource", { "references/raw/r.md": doc("type: Raw Source\nlanguage: th\n") }, "error:raw-resource:references/raw/r.md"],
  ["index with frontmatter", { "a.md": doc("type: N\n"), "sub/index.md": "---\nx: 1\n---\n", "sub/b.md": doc("type: N\n") }, "warning:index-format:sub/index.md"],
  ["root index with extra keys", { "a.md": doc("type: N\n"), "index.md": "---\nokf_version: \"0.2\"\nx: 1\n---\n" }, "warning:index-format:index.md"],
  ["broken index YAML", { "a.md": doc("type: N\n"), "index.md": "---\nx: [\n---\n" }, "warning:index-format:index.md"],
  ["log with bad date heading", { "a.md": doc("type: N\n"), "log.md": "# Log\n\n## Oct 14\n" }, "warning:log-format:log.md"],
  ["invalid policy", { "a.md": doc("type: N\n"), ".okf.yaml": "auto_index: maybe\n" }, "warning:policy-invalid:.okf.yaml"],
  [
    "table without a footnote in a concept citing a raw source",
    {
      "references/raw/r.md": doc("type: Raw Source\nlanguage: th\nresource: x\n"),
      "a.md": doc("type: N\nsources:\n  - { id: r, resource: /references/raw/r.md }\n", "Claim.[^r]\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[^r]: [R](references/raw/r.md)\n"),
    },
    "warning:table-uncited:a.md",
  ],
];

describe("lint rules", () => {
  it.each(cases)("%s", (_name, files, expected) => {
    expect(codesFor(files)).toContain(expected);
  });

  it("accepts a clean concept with no diagnostics", () => {
    const files = {
      "concepts/a.md": doc(
        "type: Note\ntitle: A\ndescription: A clean concept.\ntags: [ok]\nstatus: stable\n" +
          "generated: { by: agent/1, at: 2026-10-01T00:00:00Z }\nverified:\n  - { by: human:ys, at: 2026-10-02T00:00:00Z }\n" +
          "stale_after: 2027-01-01T00:00:00Z\nsources:\n  - { id: s, resource: https://example.com }\n",
        "Claim.[^s] See [b](b.md).\n\n[^s]: Example\n",
      ),
      "concepts/b.md": doc("type: Note\n"),
    };
    expect(codesFor(files)).toEqual([]);
  });
});

describe("policy parsing", () => {
  it("handles empty, invalid and non-mapping files and every key", () => {
    expect(parsePolicy(undefined).problems).toEqual([]);
    expect(parsePolicy("x: [\n").problems[0]).toMatch(/not valid YAML/);
    expect(parsePolicy("- a\n").problems[0]).toMatch(/mapping/);
    const { policy, problems } = parsePolicy(
      'okf_version: "0.2"\ncontent_language: en\nraw_dirs: [raw]\nnon_english_threshold: 0.1\nauto_index: false\nauto_log: false\nagent_initial_status: stable\n',
    );
    expect(problems).toEqual([]);
    expect(policy).toMatchObject({ raw_dirs: ["raw"], non_english_threshold: 0.1, auto_index: false, agent_initial_status: "stable" });
    expect(parsePolicy("okf_version: ''\nraw_dirs: x\nagent_initial_status: deprecated\nauto_log: 1\n").problems).toHaveLength(4);
  });
});
