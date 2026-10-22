// Provenance: the `sources` family (OKF §5.1).

export interface SourceEntry {
  id?: string;
  resource?: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: string;
  [key: string]: unknown;
}

/** `sources` as a list of mappings; a bare mapping counts as one entry. */
export function normalizeSources(frontmatter: Record<string, unknown>): SourceEntry[] {
  const s = frontmatter["sources"];
  const items = Array.isArray(s) ? s : s && typeof s === "object" ? [s] : [];
  return items.filter((e): e is SourceEntry => !!e && typeof e === "object" && !Array.isArray(e));
}

export interface SourceProblems {
  missingResource: number[];
  duplicateIds: string[];
}

export function sourceProblems(sources: SourceEntry[]): SourceProblems {
  const missingResource: number[] = [];
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  sources.forEach((s, i) => {
    if (typeof s.resource !== "string" || s.resource.trim() === "") missingResource.push(i);
    if (typeof s.id === "string") {
      if (seen.has(s.id)) duplicateIds.add(s.id);
      seen.add(s.id);
    }
  });
  return { missingResource, duplicateIds: [...duplicateIds] };
}

/**
 * Merge `incoming` into `existing` without dropping anything: entries with a matching
 * `id` are replaced, entries without an `id` are matched by `resource`, others appended.
 */
export function upsertSources(existing: SourceEntry[], incoming: SourceEntry[]): SourceEntry[] {
  const out = existing.map((e) => ({ ...e }));
  for (const entry of incoming) {
    const i = out.findIndex((e) =>
      typeof entry.id === "string" ? e.id === entry.id : e.id === undefined && e.resource === entry.resource,
    );
    if (i === -1) out.push({ ...entry });
    else out[i] = { ...entry };
  }
  return out;
}

/** Remove entries by id. */
export function removeSources(existing: SourceEntry[], ids: string[]): SourceEntry[] {
  const drop = new Set(ids);
  return existing.filter((e) => !(typeof e.id === "string" && drop.has(e.id)));
}
