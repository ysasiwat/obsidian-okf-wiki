// Full-text search over concepts (DESIGN.md §7.1). BM25 via MiniSearch with one tokenizer
// for every language: ICU word segmentation plus character bigrams for scripts written
// without spaces (Thai, Lao, Khmer, Myanmar, CJK), because ICU splits the same Thai word
// differently in different contexts (ADR 0001, S7).

import MiniSearch from "minisearch";

const UNSPACED = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const UNSPACED_RUN = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{M}]+/gu;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Lowercased word tokens plus bigrams of unspaced-script runs. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike) tokens.push(s.segment.toLowerCase());
  }
  for (const run of text.match(UNSPACED_RUN) ?? []) {
    const chars = [...run].filter((c) => UNSPACED.test(c) || /\p{M}/u.test(c));
    // Bigrams over base characters, keeping combining marks attached to their base.
    const units: string[] = [];
    for (const c of chars) {
      if (/\p{M}/u.test(c) && units.length > 0) units[units.length - 1] += c;
      else units.push(c);
    }
    for (let i = 0; i + 1 < units.length; i++) tokens.push(`${units[i]}${units[i + 1]}`);
  }
  return tokens;
}

export interface SearchDocument {
  /** Unique key, e.g. "<bundle>\u0000<path>". */
  id: string;
  title: string;
  description: string;
  tags: string;
  aliases: string;
  body: string;
}

export interface SearchHit {
  id: string;
  score: number;
  terms: string[];
}

const FIELDS = ["title", "aliases", "tags", "description", "body"] as const;

export class ConceptSearch {
  private index = this.create();
  private docs = new Map<string, SearchDocument>();

  private create(): MiniSearch<SearchDocument> {
    return new MiniSearch<SearchDocument>({
      fields: [...FIELDS],
      storeFields: [],
      tokenize,
      processTerm: (t) => t,
      searchOptions: {
        boost: { title: 3, aliases: 2.5, tags: 2, description: 2, body: 1 },
        prefix: (term) => /^[a-z0-9]/.test(term) && term.length >= 3,
        fuzzy: (term) => (/^[a-z]+$/.test(term) && term.length >= 5 ? 0.2 : false),
        combineWith: "OR",
      },
    });
  }

  /** Insert or replace a document. */
  // remove(doc), not discard(id): discard leaves the old terms in the statistics, so scores drift
  // from those of an index built from scratch.
  upsert(doc: SearchDocument): void {
    const old = this.docs.get(doc.id);
    if (old) this.index.remove(old);
    this.index.add(doc);
    this.docs.set(doc.id, doc);
  }

  remove(id: string): void {
    const old = this.docs.get(id);
    if (!old) return;
    this.index.remove(old);
    this.docs.delete(id);
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get size(): number {
    return this.docs.size;
  }

  get(id: string): SearchDocument | undefined {
    return this.docs.get(id);
  }

  search(query: string, filter?: (id: string) => boolean): SearchHit[] {
    if (!query.trim()) return [];
    return this.index
      .search(query, filter ? { filter: (r) => filter(String(r.id)) } : {})
      .map((r) => ({ id: String(r.id), score: r.score, terms: r.terms }));
  }
}

/** A short excerpt of `text` around the first matched term. */
export function snippet(text: string, terms: string[], width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return flat.slice(0, width) + (flat.length > width ? "…" : "");
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
