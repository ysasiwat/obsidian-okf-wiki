// Find and rewrite links in a markdown body (OKF §6.1, DESIGN.md §4.4).
//
// Code (fenced and inline), math, HTML comments and backslash escapes are masked first,
// so anything that only looks like a link inside them is never reported or rewritten.
// Offsets always refer to the original body text.

export type LinkKind = "markdown" | "image" | "wikilink" | "embed" | "reference-def";

export interface BodyLink {
  kind: LinkKind;
  /** The link destination as written (markdown) or the wikilink target (before '|'/'#'). */
  target: string;
  /** Link text, wikilink alias, or image alt. */
  text: string;
  /** Wikilink heading/block suffix such as "#Heading", else "". */
  subpath: string;
  /** Span of the whole link in the body. */
  start: number;
  end: number;
  /** Span of `target` in the body (markdown links and reference definitions only). */
  targetStart: number;
  targetEnd: number;
}

/** Replace masked regions with spaces (newlines kept) so offsets and lines are preserved. */
export function maskNonProse(body: string): string {
  const chars = body.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  };

  // Fenced code blocks: ``` or ~~~ (3+), closed by a fence of the same char and >= length.
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*$/gm;
  let m: RegExpExecArray | null;
  let searchFrom = 0;
  fence.lastIndex = 0;
  while ((m = fence.exec(body)) !== null) {
    if (m.index < searchFrom) continue;
    const marker = m[2]!;
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`, "gm");
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(body);
    const end = c ? c.index + c[0].length : body.length;
    blank(m.index, end);
    searchFrom = end;
    fence.lastIndex = end;
  }
  let masked = chars.join("");

  const maskRegex = (re: RegExp) => {
    masked = masked.replace(re, (s) => s.replace(/[^\n]/g, " "));
  };
  maskRegex(/<!--[\s\S]*?-->/g); // HTML comments
  maskRegex(/\$\$[\s\S]+?\$\$/g); // display math
  maskRegex(/(`+)[^`][\s\S]*?\1/g); // inline code spans
  maskRegex(/(?<![\\$])\$(?=\S)[^$\n]+?(?<=\S)\$(?!\d)/g); // inline math
  maskRegex(/\\[\\`*_{}[\]()#+\-.!|<>~$]/g); // backslash escapes
  return masked;
}

const INLINE = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const WIKI = /(!?)\[\[([^\]\n|#^]*)((?:[#^][^\]\n|]*)?)(?:\|([^\]\n]*))?\]\]/g;
const REFDEF = /^ {0,3}\[(?!\^)([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)/gm;

/** Every link in `body`, in document order. */
export function extractLinks(body: string): BodyLink[] {
  const masked = maskNonProse(body);
  const links: BodyLink[] = [];
  let m: RegExpExecArray | null;

  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(masked)) !== null) {
    if (m[3] === "" && m[2] === "") continue;
    const start = m.index;
    const end = start + m[0].length;
    const openParen = masked.indexOf("(", start + 1 + m[1]!.length + m[2]!.length + 1);
    const targetStart = masked.slice(openParen + 1).search(/\S/) + openParen + 1;
    const rawTarget = body.slice(targetStart, targetStart + m[3]!.length);
    links.push({
      kind: m[1] ? "image" : "markdown",
      target: rawTarget,
      text: body.slice(start + m[1]!.length + 1, start + m[1]!.length + 1 + m[2]!.length),
      subpath: "",
      start, end, targetStart, targetEnd: targetStart + rawTarget.length,
    });
  }

  WIKI.lastIndex = 0;
  while ((m = WIKI.exec(masked)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const original = body.slice(start, end);
    const inner = /^(!?)\[\[([^\]|#^]*)((?:[#^][^\]|]*)?)(?:\|([^\]]*))?\]\]$/.exec(original);
    if (!inner) continue;
    links.push({
      kind: inner[1] ? "embed" : "wikilink",
      target: inner[2]!.trim(),
      text: inner[4] ?? "",
      subpath: inner[3] ?? "",
      start, end, targetStart: -1, targetEnd: -1,
    });
  }

  REFDEF.lastIndex = 0;
  while ((m = REFDEF.exec(masked)) !== null) {
    const targetStart = m.index + m[0].length - m[2]!.length;
    links.push({
      kind: "reference-def",
      target: body.slice(targetStart, targetStart + m[2]!.length),
      text: m[1]!,
      subpath: "",
      start: m.index, end: m.index + m[0].length, targetStart, targetEnd: targetStart + m[2]!.length,
    });
  }

  return links.sort((a, b) => a.start - b.start);
}

export interface LinkReplacement {
  link: BodyLink;
  /** Replaces only the target for markdown/image/reference-def links. */
  target?: string;
  /** Replaces the whole link (e.g. converting a wikilink to a markdown link). */
  whole?: string;
}

/** Apply replacements to `body`. Replacements must not overlap. */
export function rewriteLinks(body: string, replacements: LinkReplacement[]): string {
  const edits = replacements
    .map((r) => {
      if (r.whole !== undefined) return { start: r.link.start, end: r.link.end, text: r.whole };
      if (r.target !== undefined && r.link.targetStart >= 0) {
        return { start: r.link.targetStart, end: r.link.targetEnd, text: r.target };
      }
      return null;
    })
    .filter((e): e is { start: number; end: number; text: string } => e !== null)
    .sort((a, b) => b.start - a.start);
  let out = body;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.end > lastStart) throw new Error("overlapping link replacements");
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

export interface Footnotes {
  /** Labels referenced in prose, e.g. `[^ga4-schema]`. */
  references: Set<string>;
  /** Labels defined with `[^label]: ...` at line start. */
  definitions: Set<string>;
}

/** 1-based body line of each table (rows starting with `|` around a delimiter row) that holds no footnote reference. */
export function uncitedTables(body: string): number[] {
  const lines = maskNonProse(body).split(/\r?\n/);
  const out: number[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!/^ {0,3}\|/.test(lines[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && /^ {0,3}\|/.test(lines[i]!)) i++;
    const rows = lines.slice(start, i);
    const isTable = rows.some((r) => /^ {0,3}\|?[\s:|-]*-{3,}[\s:|-]*$/.test(r) && r.includes("|"));
    if (isTable && !rows.some((r) => /\[\^[^\]\s]+\]/.test(r))) out.push(start + 1);
  }
  return out;
}

/** Footnote labels used and defined in `body` (OKF §5.1 per-claim attribution). */
export function extractFootnotes(body: string): Footnotes {
  const masked = maskNonProse(body);
  const definitions = new Set<string>();
  const references = new Set<string>();
  const defRe = /^ {0,3}\[\^([^\]\s]+)\]:/gm;
  let m: RegExpExecArray | null;
  const defStarts = new Set<number>();
  while ((m = defRe.exec(masked)) !== null) {
    definitions.add(m[1]!);
    defStarts.add(m.index + m[0].indexOf("["));
  }
  const refRe = /\[\^([^\]\s]+)\]/g;
  while ((m = refRe.exec(masked)) !== null) {
    if (!defStarts.has(m.index)) references.add(m[1]!);
  }
  return { references, definitions };
}
