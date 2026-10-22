// Headings and sections of a markdown body, for progressive disclosure (DESIGN.md §6.2,
// §7.1 `okf_read` view "outline" / "section"). ATX headings only; headings inside code
// fences are ignored.

import { maskNonProse } from "./links";

export interface Heading {
  level: number;
  text: string;
  /** Heading texts from the top level down to this heading. */
  path: string[];
  /** Offset of the heading line in the body. */
  start: number;
  /** Offset where the section (heading plus content, including subsections) ends. */
  end: number;
}

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm;

export function extractHeadings(body: string): Heading[] {
  const masked = maskNonProse(body);
  const found: { level: number; text: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  ATX.lastIndex = 0;
  while ((m = ATX.exec(masked)) !== null) {
    // Text comes from the original so inline code in a heading survives.
    const lineEnd = body.indexOf("\n", m.index);
    const original = body.slice(m.index, lineEnd === -1 ? body.length : lineEnd);
    const om = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(original);
    found.push({ level: m[1]!.length, text: (om ? om[2]! : m[2]!).trim(), start: m.index });
  }
  const stack: { level: number; text: string }[] = [];
  return found.map((h, i) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    let end = body.length;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j]!.level <= h.level) {
        end = found[j]!.start;
        break;
      }
    }
    return { level: h.level, text: h.text, path: stack.map((s) => s.text), start: h.start, end };
  });
}

/**
 * Find a section by heading path. A full path from the top level matches exactly; a
 * shorter path matches when it is the unique tail of one heading's path.
 */
export function findSection(body: string, path: string[]): { heading: Heading; text: string } | { error: string } {
  if (path.length === 0) return { error: "section path is empty" };
  const headings = extractHeadings(body);
  const norm = (s: string) => s.trim().toLowerCase();
  const want = path.map(norm);
  const exact = headings.filter((h) => h.path.length === want.length && h.path.every((p, i) => norm(p) === want[i]));
  const candidates =
    exact.length > 0
      ? exact
      : headings.filter((h) => h.path.length >= want.length && h.path.slice(-want.length).every((p, i) => norm(p) === want[i]));
  if (candidates.length === 0) return { error: `no section matches ${JSON.stringify(path)}` };
  if (candidates.length > 1) {
    return { error: `${candidates.length} sections match ${JSON.stringify(path)}; give the full path, one of ${JSON.stringify(candidates.map((c) => c.path))}` };
  }
  const heading = candidates[0]!;
  return { heading, text: `${body.slice(heading.start, heading.end).trimEnd()}\n` };
}
