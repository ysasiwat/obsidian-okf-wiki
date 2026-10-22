// Concept ids and the bundle-relative paths they map to (OKF §2, §3.1; DESIGN.md §4.2).
//
// Reading accepts any file path inside the bundle (a person may have named a note
// "My Note.md"). Creating or moving a concept requires the strict grammar below, which
// is portable across case-insensitive filesystems and needs no escaping in links.

export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/** One path segment of a newly created concept id. */
export const STRICT_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_SEGMENT_LENGTH = 100;
export const MAX_DEPTH = 16;

/** Names Windows reserves for devices, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;

export function isReservedFilename(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (RESERVED_FILENAMES as readonly string[]).includes(base);
}

/** `tables/orders.md` -> `tables/orders`. */
export function conceptIdFromPath(bundlePath: string): string {
  return bundlePath.replace(/\.md$/, "");
}

/** `tables/orders` -> `tables/orders.md`. */
export function pathFromConceptId(conceptId: string): string {
  return `${conceptId}.md`;
}

/** Problems that keep `conceptId` from being used for a new or moved concept. */
export function strictConceptIdErrors(conceptId: string): string[] {
  const errors: string[] = [];
  if (conceptId.length === 0) return ["concept id is empty"];
  if (conceptId.startsWith("/") || conceptId.endsWith("/")) {
    errors.push("concept id must not start or end with '/'");
  }
  if (conceptId.endsWith(".md")) errors.push("concept id must not include the .md suffix");
  const segments = conceptId.split("/").filter((s) => s.length > 0);
  if (segments.length > MAX_DEPTH) errors.push(`concept id has more than ${MAX_DEPTH} segments`);
  for (const seg of segments) {
    if (!STRICT_SEGMENT.test(seg)) {
      errors.push(
        `segment '${seg}' must be lowercase ASCII letters, digits, '.', '_' or '-', starting with a letter or digit`,
      );
    } else if (seg.endsWith(".")) {
      errors.push(`segment '${seg}' must not end with '.' (Windows drops trailing dots)`);
    } else if (WINDOWS_DEVICE.test(seg)) {
      errors.push(`segment '${seg}' is a reserved device name on Windows`);
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      errors.push(`segment '${seg.slice(0, 20)}…' is longer than ${MAX_SEGMENT_LENGTH} characters`);
    }
  }
  const last = segments[segments.length - 1];
  if (last === "index" || last === "log") {
    errors.push(`'${last}.md' is a reserved OKF filename and cannot be a concept`);
  }
  return errors;
}

/** Whether an existing file name would pass the strict grammar (for the `nonportable-id` lint). */
export function isPortableConceptPath(bundlePath: string): boolean {
  return strictConceptIdErrors(conceptIdFromPath(bundlePath)).length === 0;
}
