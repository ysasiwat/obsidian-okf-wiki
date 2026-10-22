// Parse and rebuild OKF concept documents without disturbing bytes we did not change.
//
// A document is split into its raw frontmatter text and raw body text. Line endings are
// normalized to LF for processing and restored on output, so a CRLF file (common in
// Windows vaults with git autocrlf) is written back as CRLF. A leading BOM is kept too.
// See DESIGN.md §4.3 and ADR 0001 (S5).

import { parseDocument } from "yaml";

export type Eol = "\n" | "\r\n";

export class OkfParseError extends Error {
  constructor(
    message: string,
    readonly code: "unterminated-frontmatter" | "invalid-yaml" | "frontmatter-not-mapping",
  ) {
    super(message);
  }
}

export interface ConceptText {
  /** Line ending to write the document back with. */
  eol: Eol;
  bom: boolean;
  /** Raw YAML between the delimiters, LF-normalized, ending with "\n" unless empty; null when absent. */
  frontmatterText: string | null;
  /** The opening and closing delimiter lines exactly as written (normally "---"). */
  openDelimiter: string;
  closeDelimiter: string;
  /** Whether the closing delimiter line ended with a newline. */
  closeNewline: boolean;
  /** An opening delimiter with no closing one; the whole text is then in `body`. */
  unterminated: boolean;
  /** Everything after the closing delimiter line, LF-normalized. */
  body: string;
}

const DELIMITER = /^---[ \t]*$/;

/** The file's line ending: CRLF only when every LF is preceded by CR. */
export function detectEol(text: string): Eol {
  const lf = text.split("\n").length - 1;
  if (lf === 0) return "\n";
  const crlf = text.split("\r\n").length - 1;
  return crlf === lf ? "\r\n" : "\n";
}

/** Split a document into frontmatter text and body. Never throws. */
export function splitConcept(text: string): ConceptText {
  let rest = text;
  const bom = rest.startsWith("﻿");
  if (bom) rest = rest.slice(1);
  const eol = detectEol(rest);
  if (eol === "\r\n") rest = rest.replace(/\r\n/g, "\n");

  const none: ConceptText = {
    eol, bom, frontmatterText: null, openDelimiter: "---", closeDelimiter: "---",
    closeNewline: true, unterminated: false, body: rest,
  };
  const firstEnd = rest.indexOf("\n");
  if (firstEnd === -1) return none;
  const first = rest.slice(0, firstEnd);
  if (!DELIMITER.test(first)) return none;

  let pos = firstEnd + 1;
  while (pos <= rest.length) {
    const lineEnd = rest.indexOf("\n", pos);
    const line = rest.slice(pos, lineEnd === -1 ? rest.length : lineEnd);
    if (DELIMITER.test(line)) {
      return {
        eol, bom,
        frontmatterText: rest.slice(firstEnd + 1, pos),
        openDelimiter: first,
        closeDelimiter: line,
        closeNewline: lineEnd !== -1,
        unterminated: false,
        body: lineEnd === -1 ? "" : rest.slice(lineEnd + 1),
      };
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return { ...none, unterminated: true };
}

/** Rebuild the exact document text from its parts. */
export function joinConcept(parts: ConceptText): string {
  let out: string;
  if (parts.frontmatterText === null) {
    out = parts.body;
  } else {
    out =
      `${parts.openDelimiter}\n${parts.frontmatterText}${parts.closeDelimiter}` +
      (parts.closeNewline ? "\n" : "") +
      parts.body;
  }
  if (parts.eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  return (parts.bom ? "﻿" : "") + out;
}

/** Parse YAML frontmatter text as a mapping (YAML 1.2 core: timestamps stay strings). */
export function parseFrontmatter(frontmatterText: string): Record<string, unknown> {
  const doc = parseDocument(frontmatterText, { version: "1.2", uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new OkfParseError(`Invalid YAML in frontmatter: ${doc.errors[0]!.message}`, "invalid-yaml");
  }
  const value: unknown = doc.toJS({ maxAliasCount: 50 });
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new OkfParseError("Frontmatter must be a YAML mapping", "frontmatter-not-mapping");
  }
  return value as Record<string, unknown>;
}

export interface ParsedConcept extends ConceptText {
  frontmatter: Record<string, unknown>;
}

/**
 * Parse a concept document. A document without frontmatter parses with an empty
 * mapping and `frontmatterText: null`; conformance checks report that separately.
 */
export function parseConcept(text: string): ParsedConcept {
  const parts = splitConcept(text);
  if (parts.unterminated) {
    throw new OkfParseError("Unterminated YAML frontmatter block", "unterminated-frontmatter");
  }
  const frontmatter = parts.frontmatterText === null ? {} : parseFrontmatter(parts.frontmatterText);
  return { ...parts, frontmatter };
}
