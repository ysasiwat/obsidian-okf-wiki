import { describe, expect, it } from "vitest";
import { analyzeBundle } from "../../src/core/bundle";
import { bodyIsNonEnglish, isLanguageTag, nonEnglishFrontmatterFields, proseForLanguageCheck } from "../../src/core/language";
import { lintBundle } from "../../src/core/lint";
import { parsePolicy, zoneOf, DEFAULT_POLICY } from "../../src/core/policy";
import { rawBodyModified, rawContentHash } from "../../src/core/raw";
import { renderNewConcept } from "../../src/core/edit";

const T = DEFAULT_POLICY.non_english_threshold;

describe("language policy (DESIGN.md §4.8)", () => {
  it("rejects a Thai body and accepts an English one", () => {
    expect(bodyIsNonEnglish("ดาวเทียมสำรวจทรัพยากรถ่ายภาพพื้นที่น้ำท่วมในภาคเหนือ", T).violates).toBe(true);
    expect(bodyIsNonEnglish("The satellite imaged flooded areas in the north.", T).violates).toBe(false);
  });

  it("exempts quoted proper nouns, code, URLs, footnote definitions and blockquotes", () => {
    const body = [
      'ACME operates the "ธีออส-2" satellite (ธีออส) for Earth observation.',
      "",
      "```",
      "SELECT 'ภาษาไทยในโค้ด' FROM t",
      "```",
      "See `ไทย` and https://example.com/ข้อมูล for details.[^src]",
      "",
      "> ข้อความต้นฉบับที่ยกมาอ้างอิง",
      "",
      "[^src]: [รายงานประจำปี](../references/raw/report.md)",
    ].join("\n");
    expect(bodyIsNonEnglish(body, T).violates).toBe(false);
  });

  it("does not exempt long parenthesized Thai passages", () => {
    const body = "Summary (ดาวเทียมดวงนี้ถ่ายภาพพื้นที่น้ำท่วมในภาคเหนือของประเทศไทยเมื่อเดือนที่แล้ว) done.";
    expect(proseForLanguageCheck(body)).toContain("ดาวเทียม");
    expect(bodyIsNonEnglish(body, T).violates).toBe(true);
  });

  it("requires English title, description and tags in every zone", () => {
    expect(nonEnglishFrontmatterFields({ title: "ธีออส-2", description: "Earth observation satellite", tags: ["ดาวเทียม"] }))
      .toEqual(["title", "tags"]);
    expect(nonEnglishFrontmatterFields({ title: "THEOS-2", aliases: ["ธีออส-2"] })).toEqual([]);
  });

  it("recognizes BCP 47 tags", () => {
    for (const t of ["th", "en", "en-US", "zh-Hant-TW"]) expect(isLanguageTag(t)).toBe(true);
    for (const t of ["thai", "", "t", "th_TH"]) expect(isLanguageTag(t)).toBe(false);
  });
});

describe("policy", () => {
  it("uses defaults and reports bad keys", () => {
    const { policy, problems } = parsePolicy("raw_dirs: [sources/raw/]\nnon_english_threshold: 2\nfoo: 1\n");
    expect(policy.raw_dirs).toEqual(["sources/raw"]);
    expect(policy.non_english_threshold).toBe(DEFAULT_POLICY.non_english_threshold);
    expect(problems).toHaveLength(2);
  });

  it("decides zones by path", () => {
    expect(zoneOf("references/raw/report.md", DEFAULT_POLICY)).toBe("raw");
    expect(zoneOf("references/rawish/report.md", DEFAULT_POLICY)).toBe("curated");
    expect(zoneOf("concepts/a.md", DEFAULT_POLICY)).toBe("curated");
  });
});

describe("raw sources", () => {
  it("hashes bodies independently of line endings", () => {
    expect(rawContentHash("a\r\nb\r\n")).toBe(rawContentHash("a\nb\n"));
    const body = "\nเนื้อหาต้นฉบับ\n";
    expect(rawBodyModified({ content_sha256: rawContentHash(body) }, body)).toBe(false);
    expect(rawBodyModified({ content_sha256: rawContentHash(body) }, `${body}x`)).toBe(true);
  });

  it("lints a Thai raw source as valid and its English distillation as valid", () => {
    const rawBody = "รายงานประจำปี 2568 ของ ACME ระบุว่าดาวเทียมธีออส-2 ถ่ายภาพได้ทุกวัน\n";
    const files = new Map<string, string>([
      [
        "references/raw/acme-annual-report-2025.md",
        renderNewConcept(
          {
            type: "Raw Source",
            title: "ACME Annual Report 2025",
            description: "Converted text of the ACME annual report for fiscal year 2025.",
            resource: "https://example.org/annual-report-2025.pdf",
            language: "th",
            original_title: "รายงานประจำปี 2568",
            content_sha256: rawContentHash(`\n${rawBody}`),
          },
          rawBody,
        ),
      ],
      [
        "concepts/theos-2.md",
        renderNewConcept(
          {
            type: "Satellite",
            title: "THEOS-2",
            description: "Thailand's Earth observation satellite.",
            aliases: ["ธีออส-2"],
            sources: [{ id: "acme-ar-2025", resource: "/references/raw/acme-annual-report-2025.md", language: "th" }],
          },
          "THEOS-2 images Thailand daily.[^acme-ar-2025]\n\n[^acme-ar-2025]: [ACME Annual Report 2025](../references/raw/acme-annual-report-2025.md)\n",
        ),
      ],
    ]);
    const diagnostics = lintBundle(analyzeBundle(files));
    expect(diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(diagnostics.map((d) => d.code)).not.toContain("raw-unreferenced");
  });

  it("flags a modified raw body, a missing language and Thai in a curated body", () => {
    const files = new Map<string, string>([
      ["references/raw/r.md", "---\ntype: Raw Source\nresource: x\ncontent_sha256: abc\n---\nเนื้อหา\n"],
      ["concepts/c.md", "---\ntype: Note\n---\nเนื้อหาภาษาไทยทั้งหมดในพื้นที่ curated\n"],
      ["references/raw/fake.md", "---\ntype: Note\nlanguage: th\nresource: x\n---\nok\n"],
    ]);
    const codes = lintBundle(analyzeBundle(files)).map((d) => `${d.path}:${d.code}`);
    expect(codes).toEqual(expect.arrayContaining([
      "references/raw/r.md:raw-modified",
      "references/raw/r.md:raw-language",
      "concepts/c.md:language-not-english",
      "references/raw/fake.md:raw-type",
      "references/raw/r.md:raw-unreferenced",
    ]));
  });
});
