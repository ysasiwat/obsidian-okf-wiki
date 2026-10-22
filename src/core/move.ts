// Link rewrites for moving a concept (DESIGN.md §6.5). Computed from the bundle as it is
// before the move; the writer renames the file without Obsidian's own link updating, then
// writes these texts, so the result does not depend on the "Automatically update internal
// links" setting. Only links that resolve to the moved file (inbound) or that resolved from
// its old location (outbound) change, so running it twice changes nothing more.

import type { BundleModel } from "./bundle";
import { editConcept } from "./edit";
import { extractLinks, rewriteLinks, type LinkReplacement } from "./links";
import { decodeLinkTarget, encodeLinkTarget, relativePath } from "./paths";
import { normalizeSources } from "./sources";

/**
 * Point links in the bundle-root log.md at the moved concept's new path, so history stays
 * navigable. Link text and every other byte are kept.
 */
export function rewriteLogLinks(logText: string, from: string, to: string): string {
  const replacements: LinkReplacement[] = extractLinks(logText)
    .filter((l) => l.kind === "markdown" && decodeLinkTarget(l.target).path.replace(/^\/+/, "") === from)
    .map((l) => ({ link: l, target: `${encodeLinkTarget(to)}${decodeLinkTarget(l.target).fragment}` }));
  return replacements.length ? rewriteLinks(logText, replacements) : logText;
}

/** New texts by path (paths as they are after the move). */
export function planMoveRewrites(model: BundleModel, from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const c of model.concepts.values()) {
    const isMoved = c.path === from;
    const docPath = isMoved ? to : c.path;
    const replacements: LinkReplacement[] = [];

    for (const l of c.links) {
      if (!l.target) continue;
      const pointsToMoved = l.target === from;
      if (!pointsToMoved && !isMoved) continue;
      const newTarget = pointsToMoved ? to : l.target;
      if (l.link.kind === "wikilink" || l.link.kind === "embed") {
        if (!pointsToMoved) continue; // wikilinks name targets, not positions
        const id = newTarget.replace(/\.md$/, "");
        const bang = l.link.kind === "embed" ? "!" : "";
        replacements.push({ link: l.link, whole: `${bang}[[${id}${l.link.subpath}${l.link.text ? `|${l.link.text}` : ""}]]` });
        continue;
      }
      const { path, fragment } = decodeLinkTarget(l.link.target);
      if (path.startsWith("/")) {
        if (pointsToMoved) replacements.push({ link: l.link, target: `/${encodeLinkTarget(newTarget)}${fragment}` });
        continue;
      }
      const next = `${encodeLinkTarget(relativePath(docPath, newTarget))}${fragment}`;
      if (next !== l.link.target) replacements.push({ link: l.link, target: next });
    }

    // Frontmatter path fields: rewrite those that point at the moved file, and the moved
    // file's own document-relative ones, to bundle-absolute form.
    let fm: Record<string, unknown> | null = null;
    const needs = c.fieldPaths.filter((f) => f.target && (f.target === from || (isMoved && f.resolution.kind === "path" && !f.value.startsWith("/"))));
    if (needs.length > 0) {
      fm = { ...c.frontmatter };
      const abs = (target: string) => `/${target === from ? to : target}`;
      for (const f of needs) {
        const target = f.target!;
        if (f.field === "resource" || f.field === "computation") fm[f.field] = abs(target);
        else if (f.field === "executor.resource" || f.field === "attester.resource") {
          const key = f.field.split(".")[0]!;
          fm[key] = { ...(fm[key] as Record<string, unknown>), resource: abs(target) };
        } else {
          const i = Number(/^sources\[(\d+)\]/.exec(f.field)?.[1]);
          const sources = normalizeSources(fm).map((s) => ({ ...s }));
          if (sources[i]) sources[i].resource = abs(target);
          fm["sources"] = sources;
        }
      }
    }

    if (replacements.length === 0 && fm === null && !isMoved) continue;
    const text = model.files.get(c.path) ?? "";
    const body = replacements.length > 0 ? rewriteLinks(c.body, replacements) : undefined;
    const next = body === undefined && fm === null ? text : editConcept(text, { ...(fm ? { frontmatter: fm } : {}), ...(body !== undefined ? { body } : {}) });
    if (isMoved || next !== text) out.set(docPath, next);
  }
  return out;
}
