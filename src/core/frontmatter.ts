// Edit frontmatter by splicing whole top-level keys.
//
// Re-serializing a parsed YAML document loses per-collection style (the OKF samples mix
// `[a, b]` with `{ by: x, at: y }`), so a one-key edit would rewrite unrelated lines.
// Instead each changed key's span is cut out and replaced with a fresh rendering of that
// key alone; every other byte stays as written. ADR 0001 (S5) measured 54/54 confined
// edits on the OKF samples with this approach.

import { Document, isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";

/** Key order for newly written documents (DESIGN.md §4.3). Existing documents keep theirs. */
export const PREFERRED_KEY_ORDER: readonly string[] = [
  "type", "title", "description", "resource", "language", "tags", "aliases", "status",
  "generated", "verified", "stale_after", "sources", "usage_window",
  "runtime", "parameters", "computation", "executor", "attester",
  "original_title", "original_format", "retrieved_at", "content_sha256",
];

/** Mappings written in flow style wherever they appear, as the OKF spec examples do. */
const FLOW_MAP_KEYS = new Set(["generated", "usage_window"]);
/** Top-level keys whose list items are written as flow mappings. */
const FLOW_ITEM_KEYS = new Set(["verified", "parameters"]);

function allScalar(node: Node): boolean {
  if (isSeq(node) || isMap(node)) {
    return node.items.every((item) => {
      const value = isMap(node) ? (item as Pair).value : item;
      return value === null || isScalar(value);
    });
  }
  return true;
}

/**
 * How to lay out collections when rendering a key:
 * - "okf": the OKF samples' conventions (`[a, b]`, `generated: { by, at }`, flow list items
 *   under `verified`/`parameters`).
 * - "block": block collections throughout, as Obsidian's Properties UI writes them
 *   (ADR 0003, S4). Used for keys, and documents, already in that style so the plugin and
 *   Obsidian do not keep flipping each other's formatting.
 */
export type RenderStyle = "okf" | "block";

/** Render `key: value` as YAML text ending in "\n". */
export function renderKey(key: string, value: unknown, style: RenderStyle = "okf"): string {
  const doc = new Document({ [key]: value });
  if (style === "block") return doc.toString({ lineWidth: 0 });
  let hasFlowMap = false;
  const visit = (node: unknown, parentKey: string | null, inSeqOf: string | null): void => {
    if (isSeq(node)) {
      if (allScalar(node)) node.flow = true;
      for (const item of node.items) visit(item, null, parentKey ?? inSeqOf);
    } else if (isMap(node)) {
      const flow =
        allScalar(node) &&
        ((parentKey !== null && FLOW_MAP_KEYS.has(parentKey)) ||
          (inSeqOf !== null && FLOW_ITEM_KEYS.has(inSeqOf)));
      if (flow) {
        node.flow = true;
        hasFlowMap = true;
      }
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : null;
        visit(pair.value, k, null);
      }
    }
  };
  const root = doc.contents;
  if (isMap(root)) {
    for (const pair of root.items) visit(pair.value, key, null);
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: hasFlowMap });
}

interface KeySpan {
  key: string;
  start: number;
  /** End of the key's own content; trailing blank and comment lines are left in place. */
  end: number;
  /** Layout of the existing value: any flow collection, only block collections, or a scalar. */
  layout: "flow" | "block" | "scalar";
}

function layoutOf(node: unknown): KeySpan["layout"] {
  const hasFlow = (n: unknown): boolean =>
    (isSeq(n) || isMap(n)) &&
    (n.flow === true || n.items.some((item) => hasFlow(isMap(n) ? (item as Pair).value : item)));
  if (!isSeq(node) && !isMap(node)) return "scalar";
  return hasFlow(node) ? "flow" : "block";
}

/**
 * The style for keys with no layout of their own (new keys, former scalars). Only keys
 * whose OKF rendering would differ from block rendering count as evidence: a block
 * `sources` list is what OKF style writes too, but a block `tags` list or `generated`
 * mapping means the document was laid out in block style (typically by Obsidian).
 */
function documentStyle(spans: KeySpan[], values: Record<string, unknown>): RenderStyle {
  let okf = 0;
  let block = 0;
  for (const s of spans) {
    if (s.layout === "scalar") continue;
    if (s.layout === "flow") {
      okf++;
      continue;
    }
    const v = values[s.key];
    if (renderKey(s.key, v, "okf") !== renderKey(s.key, v, "block")) block++;
  }
  return block > 0 && okf === 0 ? "block" : "okf";
}

function spanStyle(span: KeySpan, fallback: RenderStyle): RenderStyle {
  return span.layout === "block" ? "block" : span.layout === "flow" ? "okf" : fallback;
}

const BLANK_OR_COMMENT = /^[ \t]*(#.*)?$/;

/** Spans of each top-level key, or null when the frontmatter is not a block mapping. */
function keySpans(text: string): KeySpan[] | null {
  const doc = parseDocument(text, { version: "1.2", uniqueKeys: true });
  if (doc.errors.length > 0) return null;
  const root = doc.contents;
  if (root === null) return [];
  if (!isMap(root) || root.flow) return null;
  const starts = root.items.map((pair) => {
    const range = (pair.key as Node | null)?.range;
    return range ? range[0] : -1;
  });
  if (starts.some((s) => s < 0)) return null;
  return root.items.map((pair, i) => {
    const start = starts[i]!;
    const limit = i + 1 < starts.length ? lineStart(text, starts[i + 1]!) : text.length;
    // Walk back over trailing blank/comment lines so they stay attached to the gap.
    let end = limit;
    while (end > start) {
      const prevLineStart = lineStart(text, end - 1);
      const line = text.slice(prevLineStart, end).replace(/\n$/, "");
      if (prevLineStart <= start || !BLANK_OR_COMMENT.test(line)) break;
      end = prevLineStart;
    }
    return { key: String(isScalar(pair.key) ? pair.key.value : pair.key), start, end, layout: layoutOf(pair.value) };
  });
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

/** Structural equality that ignores mapping key order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function insertionIndex(spans: KeySpan[], key: string, textLength: number): number {
  const rank = PREFERRED_KEY_ORDER.indexOf(key);
  if (rank === -1) return textLength;
  let after: KeySpan | undefined;
  for (const span of spans) {
    const r = PREFERRED_KEY_ORDER.indexOf(span.key);
    if (r !== -1 && r < rank) after = span;
  }
  if (after) return after.end;
  const before = spans.find((s) => {
    const r = PREFERRED_KEY_ORDER.indexOf(s.key);
    return r !== -1 && r > rank;
  });
  return before ? before.start : textLength;
}

/**
 * Rewrite frontmatter text so it parses to `next`, touching only keys whose values
 * changed. `current` must be the parse of `text`. Keys absent from `next` are removed.
 */
export function updateFrontmatterText(
  text: string,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): string {
  // A key set to undefined is treated as removed.
  const target = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
  // Appending a final newline does not move any span, so spans of `base` equal those of `text`.
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  const spans = keySpans(base);
  if (spans === null) return renderFrontmatter(target);

  const docStyle = documentStyle(spans, current);
  const edits: { start: number; end: number; replacement: string; order: number }[] = [];
  for (const span of spans) {
    if (!(span.key in target)) {
      edits.push({ start: span.start, end: span.end, replacement: "", order: 0 });
    } else if (!deepEqual(current[span.key], target[span.key])) {
      edits.push({ start: span.start, end: span.end, replacement: renderKey(span.key, target[span.key], spanStyle(span, docStyle)), order: 0 });
    }
  }
  const existing = new Set(spans.map((s) => s.key));
  orderKeys(Object.keys(target).filter((k) => !existing.has(k))).forEach((key, i) => {
    const at = insertionIndex(spans, key, base.length);
    edits.push({ start: at, end: at, replacement: renderKey(key, target[key], docStyle), order: i + 1 });
  });
  if (edits.length === 0) return text;

  // Back to front so earlier offsets stay valid; among inserts at one offset, the
  // later key goes in first so the earlier one lands in front of it.
  edits.sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);
  let out = base;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

/** Render a complete frontmatter block for a new document, in preferred key order. */
export function renderFrontmatter(fm: Record<string, unknown>, order?: readonly string[]): string {
  const keys = order ?? orderKeys(Object.keys(fm));
  return keys.filter((k) => fm[k] !== undefined).map((k) => renderKey(k, fm[k])).join("");
}

export function orderKeys(keys: readonly string[]): string[] {
  const known = PREFERRED_KEY_ORDER.filter((k) => keys.includes(k));
  return [...known, ...keys.filter((k) => !PREFERRED_KEY_ORDER.includes(k))];
}
