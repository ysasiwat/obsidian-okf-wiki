// Normalize links and path fields in content an agent sends (DESIGN.md §4.4):
// - body links become standard markdown links relative to the document: wikilinks,
//   bundle-absolute "/x.md" links (Obsidian reads "/" as the vault root) and okf: ids;
// - frontmatter path fields that point into the bundle become bundle-absolute "/x.md".
// Only content in the current request is normalized; existing text elsewhere is left alone.

import type { BundleModel } from "./bundle";
import { extractLinks, rewriteLinks, type LinkReplacement } from "./links";
import { basename, decodeLinkTarget, dirname, encodeLinkTarget, isUrl, joinPath, normalizePath, relativePath, resolveFieldPath } from "./paths";
import { normalizeSources } from "./sources";

export interface Normalized<T> {
  value: T;
  warnings: string[];
  errors: string[];
}

type Resolve = { path: string } | { error: string } | { missing: string };

/** Resolve a concept reference (wikilink target, okf: id, or bundle path) to a bundle path. */
export function resolveReference(model: BundleModel, docPath: string, ref: string): Resolve {
  const t = ref.trim().replace(/^\/+/, "");
  if (t === "") return { error: "empty link target" };
  const names = /\.[A-Za-z0-9]+$/.test(t) ? [t] : [`${t}.md`, t];
  const exists = (p: string) => model.files.has(p);
  for (const n of names) {
    const fromRoot = normalizePath(n);
    if (fromRoot !== null && exists(fromRoot)) return { path: fromRoot };
  }
  for (const n of names) {
    const fromDoc = joinPath(dirname(docPath), n);
    if (fromDoc !== null && exists(fromDoc)) return { path: fromDoc };
  }
  // Obsidian-style shortest form: a unique file name anywhere in the bundle.
  const want = basename(names[0]!).toLowerCase();
  const matches = [...model.files.keys()].filter((p) => basename(p).toLowerCase() === want);
  if (matches.length === 1) return { path: matches[0]! };
  if (matches.length > 1) return { error: `'${ref}' matches ${matches.length} files: ${matches.join(", ")}; use the full concept id` };
  const guess = normalizePath(names[0]!);
  return guess === null ? { error: `'${ref}' points outside the bundle` } : { missing: guess };
}

function encodeFragment(subpath: string): string {
  if (!subpath) return "";
  return `#${subpath.slice(1).replace(/ /g, "%20")}`;
}

/** Rewrite links in `body` (content written by an agent for the document at `docPath`). */
export function normalizeBodyLinks(body: string, docPath: string, model: BundleModel): Normalized<string> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const replacements: LinkReplacement[] = [];
  const rel = (target: string) => encodeLinkTarget(relativePath(docPath, target));

  for (const link of extractLinks(body)) {
    if (link.kind === "embed") {
      warnings.push(`embed ![[${link.target}]] kept as written`);
      continue;
    }
    if (link.kind === "wikilink") {
      const r = resolveReference(model, docPath, link.target);
      if ("error" in r) {
        errors.push(r.error);
        continue;
      }
      const path = "path" in r ? r.path : r.missing;
      if ("missing" in r) warnings.push(`link to '${link.target}' does not resolve yet (kept as ${path})`);
      const text = (link.text || link.target).replace(/([[\]])/g, "\\$1");
      replacements.push({ link, whole: `[${text}](${rel(path)}${encodeFragment(link.subpath)})` });
      continue;
    }
    if (isUrl(link.target)) {
      if (link.target.startsWith("okf:")) {
        const r = resolveReference(model, docPath, link.target.slice(4));
        if ("error" in r) errors.push(r.error);
        else replacements.push({ link, target: rel("path" in r ? r.path : r.missing) });
      }
      continue;
    }
    const { path, fragment } = decodeLinkTarget(link.target);
    if (path === "") continue; // same-document anchor
    if (path.startsWith("/")) {
      const abs = normalizePath(path);
      if (abs === null) {
        errors.push(`link '${link.target}' points outside the bundle`);
        continue;
      }
      if (!model.files.has(abs)) warnings.push(`link '${link.target}' does not resolve yet`);
      replacements.push({ link, target: `${rel(abs)}${fragment}` });
      continue;
    }
    const resolved = joinPath(dirname(docPath), path);
    if (resolved === null) errors.push(`link '${link.target}' points outside the bundle`);
    else if (!model.files.has(resolved)) warnings.push(`link '${link.target}' does not resolve yet`);
  }
  if (errors.length > 0) return { value: body, warnings, errors };
  return { value: rewriteLinks(body, replacements), warnings, errors };
}

const PATH_FIELDS = ["resource", "computation"] as const;
const NESTED_PATH_FIELDS = ["executor", "attester"] as const;

/**
 * Rewrite the path fields among `keys` of `frontmatter` to bundle-absolute form. URLs and
 * scope descriptors are left alone; a path that resolves nowhere is kept with a warning.
 */
export function normalizeFieldPaths(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
  docPath: string,
  model: BundleModel,
): Normalized<Record<string, unknown>> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const exists = (p: string) => model.files.has(p);
  const fix = (field: string, v: unknown): unknown => {
    if (typeof v !== "string" || v.trim() === "") return v;
    const r = resolveFieldPath(docPath, v, exists);
    if (r.kind === "outside") {
      errors.push(`${field} '${v}' points outside the bundle`);
      return v;
    }
    if (r.kind !== "path") return v;
    if (!r.exists) {
      warnings.push(`${field} '${v}' does not resolve inside the bundle`);
      return v.startsWith("/") ? v : `/${r.resolved}`;
    }
    return `/${r.resolved}`;
  };

  const out = { ...frontmatter };
  for (const key of keys) {
    if ((PATH_FIELDS as readonly string[]).includes(key)) out[key] = fix(key, out[key]);
    if ((NESTED_PATH_FIELDS as readonly string[]).includes(key)) {
      const v = out[key];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[key] = { ...(v as Record<string, unknown>), resource: fix(`${key}.resource`, (v as Record<string, unknown>)["resource"]) };
      }
    }
    if (key === "sources" && out["sources"] !== undefined) {
      out["sources"] = normalizeSources(out).map((s, i) => {
        const e = { ...s, ...(s.resource !== undefined ? { resource: fix(`sources[${i}].resource`, s.resource) } : {}) };
        // A raw source carries the original's language (DESIGN.md §4.8); fill it when left out.
        const raw = typeof e.resource === "string" ? model.concepts.get(e.resource.replace(/^\//, "")) : undefined;
        const lang = raw?.zone === "raw" ? raw.frontmatter["language"] : undefined;
        return s["language"] === undefined && typeof lang === "string" ? { ...e, language: lang } : e;
      });
    }
  }
  return { value: out, warnings, errors };
}
