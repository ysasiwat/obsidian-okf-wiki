// Raw Source concepts (DESIGN.md §4.8): the original material converted to markdown, kept
// in its own language, write-once. `content_sha256` records the body at ingest so any
// later change is detectable.

import { sha256Hex } from "./sha256";

export const RAW_TYPE = "Raw Source";

/**
 * Hash of a raw body. Line endings are normalized to LF first, so checking out the
 * bundle with git autocrlf on another machine does not look like an edit.
 */
export function rawContentHash(body: string): string {
  return sha256Hex(body.replace(/\r\n/g, "\n"));
}

export function rawBodyModified(frontmatter: Record<string, unknown>, body: string): boolean {
  const recorded = frontmatter["content_sha256"];
  return typeof recorded === "string" && recorded !== rawContentHash(body);
}
