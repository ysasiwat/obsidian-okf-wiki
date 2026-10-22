import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractHeadings, findSection } from "../../src/core/outline";
import { ConceptSearch, snippet, tokenize } from "../../src/core/search";
import { parseLog } from "../../src/core/logRender";
import { FIXTURE_ROOT } from "../helpers";

const BODY = [
  "# Schema",
  "",
  "| col | type |",
  "",
  "## Nested `code` heading ##",
  "detail",
  "```",
  "# not a heading",
  "```",
  "# Examples",
  "ex",
  "## Schema",
  "dup",
].join("\n");

describe("outline", () => {
  it("extracts ATX headings with paths and section ends, skipping code", () => {
    const hs = extractHeadings(BODY);
    expect(hs.map((h) => [h.level, h.path])).toEqual([
      [1, ["Schema"]],
      [2, ["Schema", "Nested `code` heading"]],
      [1, ["Examples"]],
      [2, ["Examples", "Schema"]],
    ]);
    expect(BODY.slice(hs[0]!.start, hs[0]!.end)).toContain("# not a heading");
  });

  it("finds sections by full path or unique tail, case-insensitively", () => {
    expect(findSection(BODY, ["examples", "schema"])).toMatchObject({ text: "## Schema\ndup\n" });
    expect(findSection(BODY, ["Schema"])).toMatchObject({ heading: { path: ["Schema"] } });
    expect(findSection(BODY, ["Nested `code` heading"])).toMatchObject({ heading: { level: 2 } });
    expect(findSection(BODY, ["Missing"])).toHaveProperty("error");
    expect(findSection("# X\n## A\n# Y\n## A\n", ["A"])).toHaveProperty("error");
    // An exact full path wins over tail matches.
    expect(findSection("## A\n# B\n## A\n", ["A"])).toMatchObject({ heading: { path: ["A"] } });
  });
});

describe("search tokenizer", () => {
  it("adds Thai bigrams so differently segmented words still match", () => {
    const a = tokenize("ดาวเทียมธีออส-2 ของ ACME");
    const b = tokenize("ใช้ข้อมูลจากดาวเทียม");
    expect(a).toContain("acme");
    expect(a).toContain("ดา");
    const shared = a.filter((t) => b.includes(t));
    expect(shared).toEqual(expect.arrayContaining(["ดา", "าว", "วเ", "เท", "ที", "ีย", "ยม"].filter((t) => a.includes(t))));
  });

  it("keeps Thai combining marks attached to their base character", () => {
    expect(tokenize("ที่")).toContain("ที่");
    expect(tokenize("น้ำท่วม")).toContain("น้ำ");
  });
});

describe("ConceptSearch", () => {
  const s = new ConceptSearch();
  s.upsert({ id: "a", title: "THEOS-2", description: "Earth observation satellite", tags: "satellite remote-sensing", aliases: "ธีออส-2 ดาวเทียม", body: "Images Thailand daily." });
  s.upsert({ id: "b", title: "Revenue", description: "Recognized revenue", tags: "finance", aliases: "", body: "Sum of amount." });
  s.upsert({ id: "r", title: "Annual report", description: "Raw source", tags: "", aliases: "", body: "ดาวเทียมสำรวจทรัพยากรถ่ายภาพได้ทุกวัน" });

  it("finds English terms with prefix and typo tolerance", () => {
    expect(s.search("satelite")[0]?.id).toBe("a");
    expect(s.search("reven")[0]?.id).toBe("b");
  });

  it("finds an English concept by its Thai alias and raw text by Thai", () => {
    expect(s.search("ดาวเทียม", (id) => id !== "r")[0]?.id).toBe("a");
    expect(s.search("ถ่ายภาพ").map((h) => h.id)).toContain("r");
  });

  it("supports replace and remove", () => {
    s.upsert({ id: "b", title: "Margin", description: "", tags: "", aliases: "", body: "" });
    expect(s.search("revenue").map((h) => h.id)).not.toContain("b");
    s.remove("b");
    expect(s.has("b")).toBe(false);
    expect(s.search("")).toEqual([]);
  });

  it("builds snippets around the first match", () => {
    const text = `${"lorem ".repeat(50)}TARGET word ${"ipsum ".repeat(50)}`;
    const sn = snippet(text, ["target"], 60);
    expect(sn).toContain("TARGET");
    expect(sn.startsWith("…")).toBe(true);
    expect(snippet("short", ["zzz"])).toBe("short");
  });
});

describe("parseLog", () => {
  it("reads the acme sample log and our own format", () => {
    const acme = parseLog(readFileSync(join(FIXTURE_ROOT, "acme_retail", "log.md"), "utf8"));
    expect(acme[0]).toMatchObject({ date: "2026-07-01" });
    expect(acme.map((e) => e.date)).toEqual(["2026-07-01", "2026-06-30", "2026-04-15", "2026-02-10"]);
    const ours = parseLog("# Log\n\n## 2026-10-14\n\n* **Update**: [A \\[x\\]](a.md) - why (by agent/1)\n");
    expect(ours).toEqual([{ date: "2026-10-14", text: "**Update**: [A \\[x\\]](a.md) - why (by agent/1)", action: "Update", title: "A [x]", link: "a.md", reason: "why", actor: "agent/1" }]);
  });
});
