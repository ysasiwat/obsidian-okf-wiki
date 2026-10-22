import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { extractFootnotes, extractLinks, maskNonProse, rewriteLinks, uncitedTables } from "../../src/core/links";

describe("extractLinks", () => {
  it("finds markdown, image, wiki, embed and reference links", () => {
    const body = [
      "See [orders](../tables/orders.md) and ![chart](img/c.png).",
      "Also [[customers]] and [[tables/orders#Schema|the schema]] and ![[photo.png]].",
      "Ref [rev][r].",
      "",
      "[r]: /metrics/revenue.md",
    ].join("\n");
    const links = extractLinks(body);
    expect(links.map((l) => [l.kind, l.target, l.text, l.subpath])).toEqual([
      ["markdown", "../tables/orders.md", "orders", ""],
      ["image", "img/c.png", "chart", ""],
      ["wikilink", "customers", "", ""],
      ["wikilink", "tables/orders", "the schema", "#Schema"],
      ["embed", "photo.png", "", ""],
      ["reference-def", "/metrics/revenue.md", "r", ""],
    ]);
    for (const l of links) {
      if (l.targetStart >= 0) expect(body.slice(l.targetStart, l.targetEnd)).toBe(l.target);
    }
  });

  it("ignores links inside code, math, comments and escapes", () => {
    const body = [
      "```sql",
      "SELECT '[x](a.md)'",
      "```",
      "Inline `[y](b.md)` and $[z](c.md)$ and <!-- [w](d.md) --> and \\[v](e.md).",
      "~~~",
      "[[not-a-link]]",
      "~~~",
      "Real [ok](f.md).",
    ].join("\n");
    expect(extractLinks(body).map((l) => l.target)).toEqual(["f.md"]);
  });

  it("handles angle-bracket targets, titles, nested brackets and parentheses", () => {
    const body = 'A [x [1]](<my file.md> "Title") and [p](wiki/Foo_(bar).md).';
    expect(extractLinks(body).map((l) => [l.text, l.target])).toEqual([
      ["x [1]", "<my file.md>"],
      ["p", "wiki/Foo_(bar).md"],
    ]);
  });

  it("does not treat footnotes as links", () => {
    expect(extractLinks("Claim.[^src]\n\n[^src]: Source title\n")).toEqual([]);
  });

  it("masking preserves length and line structure", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const masked = maskNonProse(s);
        expect(masked.length).toBe(s.length);
        expect(masked.split("\n").length).toBe(s.split("\n").length);
      }),
    );
  });
});

describe("rewriteLinks", () => {
  it("rewrites targets and whole links without touching other text", () => {
    const body = "A [x](old.md) B [[wiki|W]] C";
    const links = extractLinks(body);
    const out = rewriteLinks(body, [
      { link: links[0]!, target: "new.md" },
      { link: links[1]!, whole: "[W](wiki.md)" },
    ]);
    expect(out).toBe("A [x](new.md) B [W](wiki.md) C");
  });

  it("is the identity with no replacements", () => {
    fc.assert(fc.property(fc.string(), (s) => rewriteLinks(s, []) === s));
  });
});

describe("uncitedTables", () => {
  it("finds tables without a footnote; ignores cited tables, code and stray pipes", () => {
    const body = [
      "| A | B |", "|---|---|", "| 1 | 2 |", "",
      "| C | D |", "| :-- | --: |", "| 3[^s] | 4 |", "",
      "```", "| E | F |", "|---|---|", "```", "",
      "| not a table |", "",
      "Text", "  | G |", "  |---|", "  | 5 |",
    ].join("\n");
    expect(uncitedTables(body)).toEqual([1, 17]);
  });
});

describe("extractFootnotes", () => {
  it("separates references from definitions", () => {
    const body = "One.[^a] Two.[^b]\n\n[^a]: Source A\n[^c]: Unused\n";
    const f = extractFootnotes(body);
    expect([...f.references].sort()).toEqual(["a", "b"]);
    expect([...f.definitions].sort()).toEqual(["a", "c"]);
  });
});
