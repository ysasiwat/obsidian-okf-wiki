// Produce new document text from an edit, preserving everything the edit did not change.

import { joinConcept, parseConcept, type Eol } from "./document";
import { renderFrontmatter, updateFrontmatterText } from "./frontmatter";

/**
 * Apply a new frontmatter object and/or body to an existing document. Unchanged
 * frontmatter keys keep their bytes; the file keeps its EOL and BOM.
 */
export function editConcept(
  text: string,
  change: { frontmatter?: Record<string, unknown>; body?: string },
): string {
  const parsed = parseConcept(text);
  const parts = { ...parsed };
  if (change.frontmatter !== undefined) {
    parts.frontmatterText =
      parsed.frontmatterText === null
        ? renderFrontmatter(change.frontmatter)
        : updateFrontmatterText(parsed.frontmatterText, parsed.frontmatter, change.frontmatter);
  }
  if (change.body !== undefined) parts.body = change.body.replace(/\r\n/g, "\n");
  return joinConcept(parts);
}

/** Text of a new concept: frontmatter in preferred key order, a blank line, the body. */
export function renderNewConcept(frontmatter: Record<string, unknown>, body: string, eol: Eol = "\n"): string {
  const b = body.replace(/\r\n/g, "\n").replace(/^\n+/, "");
  return joinConcept({
    eol, bom: false,
    frontmatterText: renderFrontmatter(frontmatter),
    openDelimiter: "---", closeDelimiter: "---", closeNewline: true, unterminated: false,
    body: `\n${b.endsWith("\n") || b === "" ? b : `${b}\n`}`,
  });
}
