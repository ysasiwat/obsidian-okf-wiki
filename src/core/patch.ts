// Frontmatter patches (DESIGN.md §6.3): JSON Merge Patch (RFC 7386) for ordinary keys,
// plus list operations so an agent never has to resend `sources` or `tags` in full.

import { normalizeSources, removeSources, upsertSources, type SourceEntry } from "./sources";
import { normalizeTags } from "./tags";

export interface FrontmatterPatch {
  merge?: Record<string, unknown>;
  sources_upsert?: SourceEntry[];
  sources_remove?: string[];
  tags_add?: string[];
  tags_remove?: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** RFC 7386: null removes a key, objects merge recursively, everything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export function applyFrontmatterPatch(
  current: Record<string, unknown>,
  patch: FrontmatterPatch,
): Record<string, unknown> {
  let next = patch.merge ? (mergePatch(current, patch.merge) as Record<string, unknown>) : { ...current };

  if (patch.sources_upsert?.length || patch.sources_remove?.length) {
    let sources = normalizeSources(next);
    if (patch.sources_remove?.length) sources = removeSources(sources, patch.sources_remove);
    if (patch.sources_upsert?.length) sources = upsertSources(sources, patch.sources_upsert);
    next = { ...next };
    if (sources.length > 0) next["sources"] = sources;
    else delete next["sources"];
  }

  if (patch.tags_add?.length || patch.tags_remove?.length) {
    const remove = new Set(patch.tags_remove ?? []);
    const tags = normalizeTags(next).filter((t) => !remove.has(t));
    for (const t of patch.tags_add ?? []) if (!tags.includes(t)) tags.push(t);
    next = { ...next };
    if (tags.length > 0) next["tags"] = tags;
    else delete next["tags"];
  }
  return next;
}
