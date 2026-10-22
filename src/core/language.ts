// Language policy checks (DESIGN.md §4.8): curated concepts are English; raw sources may
// be in any language. v1 measures scripts, not languages: it catches Thai, CJK, Arabic and
// other non-Latin text, but not non-English languages written in Latin script.

import { maskNonProse } from "./links";

/** Exempt quoted or parenthesized spans up to this length (proper nouns, original terms). */
const MAX_EXEMPT_SPAN = 40;

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * The prose of `body` with the policy's exemptions blanked out: code, math, comments,
 * URLs and link targets, footnote definitions, blockquotes, and short quoted or
 * parenthesized spans.
 */
export function proseForLanguageCheck(body: string): string {
  let text = maskNonProse(body);
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  text = text
    .replace(/^ {0,3}\[\^[^\]]+\]:.*$/gm, blank) // footnote definitions
    .replace(/^ {0,3}>.*$/gm, blank) // blockquotes
    .replace(/\]\([^)\n]*\)/g, blank) // markdown link targets (link text still counts)
    .replace(/\[\[[^\]\n]*\]\]/g, blank) // wikilinks
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank); // bare URLs
  const exempt = new RegExp(
    `"[^"\\n]{1,${MAX_EXEMPT_SPAN}}"|\u201C[^\u201D\\n]{1,${MAX_EXEMPT_SPAN}}\u201D|\\([^()\\n]{1,${MAX_EXEMPT_SPAN}}\\)`,
    "g",
  );
  return text.replace(exempt, blank);
}

export interface ScriptStats {
  letters: number;
  nonLatin: number;
  /** Share of letters that are not Latin script, 0 when there are no letters. */
  ratio: number;
}

export function scriptStats(text: string): ScriptStats {
  let letters = 0;
  let nonLatin = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (!LATIN.test(ch)) nonLatin++;
  }
  return { letters, nonLatin, ratio: letters === 0 ? 0 : nonLatin / letters };
}

/** Whether a curated body violates the English policy. */
export function bodyIsNonEnglish(body: string, threshold: number): { violates: boolean; stats: ScriptStats } {
  const stats = scriptStats(proseForLanguageCheck(body));
  return { violates: stats.ratio > threshold, stats };
}

/** Frontmatter text fields that must be English in every zone. */
export const ENGLISH_ONLY_FIELDS = ["title", "description", "tags"] as const;

/** Fields among title/description/tags that contain any non-Latin letter. */
export function nonEnglishFrontmatterFields(frontmatter: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const field of ENGLISH_ONLY_FIELDS) {
    const v = frontmatter[field];
    const values = Array.isArray(v) ? v : [v];
    if (values.some((x) => typeof x === "string" && scriptStats(x).nonLatin > 0)) bad.push(field);
  }
  return bad;
}

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isLanguageTag(value: unknown): value is string {
  return typeof value === "string" && BCP47.test(value);
}
