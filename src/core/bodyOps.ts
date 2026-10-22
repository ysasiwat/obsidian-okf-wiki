// Section-level body edits (DESIGN.md §6.2), addressed by heading path as okf_read's
// outline reports it. Content passed in is placed as-is apart from line-ending tidying.

import { findSection } from "./outline";

export type BodyOp =
  | { op: "append"; content: string }
  | { op: "section_replace"; section: string[]; content: string }
  | { op: "section_append"; section: string[]; content: string }
  | { op: "section_prepend"; section: string[]; content: string }
  | { op: "section_delete"; section: string[] };

export class BodyOpError extends Error {}

/** `text` trimmed of surrounding blank lines and ending in exactly one newline. */
function block(text: string): string {
  const t = text.replace(/\r\n/g, "\n").replace(/^\s*\n/, "").trimEnd();
  return t === "" ? "" : `${t}\n`;
}

/** Join two chunks with one blank line between them. */
function joinBlocks(a: string, b: string): string {
  if (a.trim() === "") return b;
  if (b.trim() === "") return a.endsWith("\n") ? a : `${a}\n`;
  return `${a.replace(/\s*$/, "")}\n\n${b}`;
}

export function applyBodyOp(body: string, op: BodyOp): string {
  if (op.op === "append") return joinBlocks(body, block(op.content));

  const found = findSection(body, op.section);
  if ("error" in found) throw new BodyOpError(found.error);
  const { heading } = found;
  const lineEnd = body.indexOf("\n", heading.start);
  const headingEnd = lineEnd === -1 ? body.length : lineEnd + 1;
  const headingLine = body.slice(heading.start, headingEnd).replace(/\n?$/, "\n");
  const before = body.slice(0, heading.start);
  const after = body.slice(heading.end);
  const inner = body.slice(headingEnd, heading.end);
  // Keep one blank line before whatever follows the section.
  const tail = after.trim() === "" ? after.replace(/^\n+/, "") : `\n${after.replace(/^\n+/, "")}`;

  switch (op.op) {
    case "section_delete": {
      const rest = after.replace(/^\n+/, "");
      if (before.trim() === "") return rest;
      return rest === "" ? `${before.trimEnd()}\n` : `${before.trimEnd()}\n\n${rest}`;
    }
    case "section_replace": {
      const content = block(op.content);
      return `${before}${headingLine}${content ? `\n${content}` : ""}${tail}`;
    }
    case "section_append": {
      const merged = joinBlocks(block(inner), block(op.content));
      return `${before}${headingLine}${merged ? `\n${merged}` : ""}${tail}`;
    }
    case "section_prepend": {
      const merged = joinBlocks(block(op.content), block(inner));
      return `${before}${headingLine}${merged ? `\n${merged}` : ""}${tail}`;
    }
  }
}

export function applyBodyOps(body: string, ops: BodyOp[]): string {
  return ops.reduce((b, op) => applyBodyOp(b, op), body);
}
