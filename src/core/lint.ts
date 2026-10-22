// Conformance (OKF §11) and quality checks for a bundle. Errors are conformance or policy
// violations; warnings are spec SHOULDs; info is advisory. Every diagnostic carries a
// fix hint written for an agent to act on.

import type { BundleModel, Concept } from "./bundle";
import { isPortableConceptPath } from "./conceptId";
import { parseConcept } from "./document";
import { bodyIsNonEnglish, isLanguageTag, nonEnglishFrontmatterFields } from "./language";
import { extractFootnotes, uncitedTables } from "./links";
import { logProblems } from "./logRender";
import { POLICY_FILENAME } from "./policy";
import { RAW_TYPE, rawBodyModified } from "./raw";
import { normalizeSources, sourceProblems } from "./sources";
import { normalizeTags } from "./tags";
import { isIsoDateTimeWithOffset, isStale, normalizeVerified, parseActor, STATUSES } from "./trust";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: string;
  severity: Severity;
  path: string;
  message: string;
  fix_hint?: string;
}

export const MAX_DESCRIPTION_LENGTH = 200;
const TAG = /^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/;

export interface LintOptions {
  now?: Date;
}

export function lintBundle(model: BundleModel, options: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (d: Diagnostic) => out.push(d);

  for (const problem of model.policyProblems) {
    add({ code: "policy-invalid", severity: "warning", path: POLICY_FILENAME, message: problem });
  }

  for (const [path, text] of model.reserved) {
    if (path === "log.md" || path.endsWith("/log.md")) {
      for (const p of logProblems(text)) add({ code: "log-format", severity: "warning", path, message: p });
    } else {
      lintIndexFile(path, text, add);
    }
  }

  for (const concept of model.concepts.values()) out.push(...cachedConceptLint(model, concept, options));

  // Raw sources nothing cites yet: the "not distilled" queue (DESIGN.md §4.8).
  for (const c of model.concepts.values()) {
    if (c.zone !== "raw" || c.parseError) continue;
    const cited = (model.backlinks.get(c.path) ?? []).some((e) => model.concepts.get(e.from)?.zone === "curated");
    if (!cited) {
      add({
        code: "raw-unreferenced", severity: "info", path: c.path,
        message: "No curated concept cites this raw source yet.",
        fix_hint: "Distill it into an English concept that lists this file in `sources` and cites it in footnotes.",
      });
    }
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.code.localeCompare(b.code)));
}

function lintIndexFile(path: string, text: string, add: (d: Diagnostic) => void): void {
  let fm: Record<string, unknown> = {};
  try {
    fm = parseConcept(text).frontmatter;
  } catch (e) {
    add({ code: "index-format", severity: "warning", path, message: (e as Error).message });
    return;
  }
  const keys = Object.keys(fm);
  const isRoot = path === "index.md";
  if (keys.length > 0 && !(isRoot && keys.every((k) => k === "okf_version"))) {
    add({
      code: "index-format", severity: "warning", path,
      message: isRoot
        ? "A root index.md may only carry `okf_version` in its frontmatter (OKF §8)."
        : "index.md files carry no frontmatter (OKF §8).",
      fix_hint: "Regenerate indexes.",
    });
  }
}

/**
 * Results of lintConcept per concept, keyed by its parsed frontmatter object: analyzeBundle shares
 * that object (and the body and links parsed with it) across models while the file is unchanged.
 * `key` holds everything else lintConcept reads, so a hit equals a fresh run.
 */
const conceptLints = new WeakMap<object, { key: string; diagnostics: Diagnostic[] }>();

function cachedConceptLint(model: BundleModel, c: Concept, options: LintOptions): Diagnostic[] {
  const key = lintKey(model, c, options);
  const hit = conceptLints.get(c.frontmatter);
  if (hit?.key === key) return hit.diagnostics;
  const diagnostics: Diagnostic[] = [];
  lintConcept(model, c, options, (d) => diagnostics.push(d));
  conceptLints.set(c.frontmatter, { key, diagnostics });
  return diagnostics;
}

/**
 * Fill the per-concept lint cache, handing control back every `sliceMs`, so the first lintBundle
 * after a load does not block a UI thread (DESIGN.md §13 4A).
 */
export async function warmLint(model: BundleModel, options: LintOptions, pause: () => Promise<void>, sliceMs = 16): Promise<void> {
  let sliceStart = Date.now();
  for (const c of model.concepts.values()) {
    cachedConceptLint(model, c, options);
    if (Date.now() - sliceStart >= sliceMs) {
      await pause();
      sliceStart = Date.now();
    }
  }
}

function lintKey(model: BundleModel, c: Concept, options: LintOptions): string {
  return JSON.stringify([
    c.path, c.zone, model.policy.non_english_threshold, isStale(c.frontmatter, options.now),
    c.links.map((l) => [l.resolution, l.filenameMatch]),
    c.fieldPaths.map((f) => [f.resolution, f.target === null ? null : model.concepts.get(f.target)?.zone ?? null]),
  ]);
}

function lintConcept(model: BundleModel, c: Concept, options: LintOptions, add: (d: Diagnostic) => void): void {
  const at = (code: string, severity: Severity, message: string, fix_hint?: string) =>
    add({ code, severity, path: c.path, message, ...(fix_hint ? { fix_hint } : {}) });
  const fm = c.frontmatter;

  // Conformance (§11).
  if (c.parseError) {
    at("invalid-frontmatter", "error", c.parseError.message, "Fix the YAML between the --- delimiters.");
    return;
  }
  if (!c.hasFrontmatter) {
    at("missing-frontmatter", "error", "Concept has no YAML frontmatter (OKF §11).", "Add a frontmatter block with at least `type`.");
    return;
  }
  if (c.type === null) {
    at("missing-type", "error", "Frontmatter has no non-empty `type` (OKF §4.1).", "Add `type`, e.g. `type: Reference`.");
  }

  if (!isPortableConceptPath(c.path)) {
    at("nonportable-id", "info", "File name does not follow the portable concept id grammar.",
      "Move it to a lowercase ASCII name such as `my-note.md`.");
  }

  // Recommended fields.
  const desc = fm["description"];
  if (typeof desc === "string") {
    if (/\n/.test(desc.trim())) at("description-multiline", "warning", "`description` should be a single line.");
    if ([...desc.trim()].length > MAX_DESCRIPTION_LENGTH) {
      at("description-too-long", "warning", `\`description\` is longer than ${MAX_DESCRIPTION_LENGTH} characters.`,
        "Shorten it to one sentence; move detail into the body.");
    }
  }
  const tags = fm["tags"];
  if (typeof tags === "string") {
    at("tag-format", "warning", "`tags` is a single string; OKF §4.1 expects a YAML list.",
      "Write `tags: [a, b]` instead of `tags: a, b`.");
  }
  if (tags !== undefined) {
    const bad = normalizeTags(fm).filter((t) => !TAG.test(t) || /^\d+$/.test(t));
    if (bad.length > 0) {
      at("tag-invalid", "warning", `Tags must be lowercase ASCII words without spaces and not all digits: ${bad.join(", ")}.`,
        "Use kebab-case tags such as `remote-sensing`.");
    }
  }

  // Lifecycle and trust (§5).
  if (fm["status"] !== undefined && !STATUSES.includes(fm["status"] as never)) {
    const st = fm["status"];
    at("status-invalid", "warning", `Unknown status '${typeof st === "string" ? st : JSON.stringify(st)}'; expected draft, stable or deprecated.`);
  }
  if (fm["stale_after"] !== undefined && !isIsoDateTimeWithOffset(fm["stale_after"])) {
    at("timestamp-invalid", "warning", "`stale_after` must be an ISO 8601 datetime with a UTC offset; it is ignored.",
      "Write it like `2026-12-31T00:00:00Z`.");
  } else if (isStale(fm, options.now)) {
    at("stale", "info", `Concept is past its stale_after (${String(fm["stale_after"])}).`, "Re-verify the content and move stale_after forward.");
  }
  const generated = fm["generated"];
  if (generated !== undefined) {
    const g: Record<string, unknown> | null = generated && typeof generated === "object" ? { ...generated } : null;
    const by = g?.["by"];
    if (!g || typeof by !== "string") {
      at("generated-invalid", "warning", "`generated` must be a mapping with `by` (OKF §5.2).");
    } else {
      if (!parseActor(by)) at("actor-invalid", "warning", `generated.by '${by}' is not an actor (OKF §7).`);
      if (g["at"] !== undefined && !isIsoDateTimeWithOffset(g["at"])) {
        at("timestamp-invalid", "warning", "`generated.at` must be an ISO 8601 datetime with a UTC offset.");
      }
    }
  }
  for (const v of normalizeVerified(fm)) {
    if (!parseActor(v.by)) at("actor-invalid", "warning", `verified.by '${v.by}' is not an actor (OKF §7).`);
    if (v.at !== undefined && !isIsoDateTimeWithOffset(v.at)) {
      at("timestamp-invalid", "warning", "`verified[].at` must be an ISO 8601 datetime with a UTC offset.");
    }
  }

  // Provenance (§5.1).
  const sources = normalizeSources(fm);
  const sp = sourceProblems(sources);
  if (sp.missingResource.length > 0) {
    at("source-missing-resource", "warning", `sources entries ${sp.missingResource.join(", ")} have no \`resource\` (OKF §5.1).`);
  }
  if (sp.duplicateIds.length > 0) {
    at("source-duplicate-id", "warning", `Duplicate sources ids: ${sp.duplicateIds.join(", ")}.`);
  }
  const notes = extractFootnotes(c.body);
  const ids = new Set(sources.map((s) => s.id).filter((x): x is string => typeof x === "string"));
  const dangling = [...notes.references].filter((r) => !notes.definitions.has(r));
  if (dangling.length > 0) {
    at("footnote-dangling", "warning", `Footnotes referenced but not defined: ${dangling.join(", ")}.`);
  }
  const uncited = [...ids].filter((id) => !notes.references.has(id));
  if (uncited.length > 0 && notes.references.size > 0) {
    at("source-uncited", "info", `sources never cited in a footnote: ${uncited.join(", ")}.`,
      "Attribute claims with footnotes keyed by sources[].id, e.g. `[^my-source]`.");
  }
  // Every claim taken from a raw source is footnoted (DESIGN.md §4.8); the agent eval showed tables are the ones skipped.
  // The concept's own resolved fields, not model.edges: scanning every edge per concept is quadratic.
  if (c.zone === "curated" && c.fieldPaths.some((f) => f.field.startsWith("sources[") && f.target !== null && model.concepts.get(f.target)?.zone === "raw")) {
    const tables = uncitedTables(c.body);
    if (tables.length > 0) {
      at("table-uncited", "warning", `Table(s) at body line ${tables.join(", ")} have no footnote, though this concept cites a raw source.`,
        "Put a footnote such as `[^<source id>]` inside each table, e.g. in a cell of the first row it supports.");
    }
  }

  // Links (§6).
  for (const l of c.links) {
    if (l.link.kind === "wikilink" || l.link.kind === "embed") {
      at("wikilink", "warning", `Wikilink [[${l.link.target}]] is not a standard markdown link (OKF §6.1).`,
        "Run 'Convert links to OKF form' or write `[text](relative/path.md)`.");
    }
    if (l.resolution.kind === "outside") {
      at("link-outside-bundle", "warning", `Link '${l.link.target}' points outside the bundle.`);
    } else if (l.resolution.kind === "path" && !l.resolution.exists && l.link.kind !== "image" && l.link.kind !== "embed") {
      const obs = l.filenameMatch ? ` Obsidian may still open '${l.filenameMatch}' by filename, but other OKF consumers will not.` : "";
      at("broken-link", "info", `Link '${l.link.target}' does not resolve inside the bundle.${obs}`,
        l.filenameMatch ? `Point the link at the file's real relative path.` : undefined);
    }
    if (l.link.kind === "markdown" && l.link.target.startsWith("/")) {
      at("absolute-link", "warning", `Link '${l.link.target}' is bundle-absolute; Obsidian resolves '/' against the vault root.`,
        "Use a path relative to this file (DESIGN.md §4.4).");
    }
  }
  for (const f of c.fieldPaths) {
    if (f.resolution.kind === "path") {
      if (f.resolution.ambiguous) {
        at("path-ambiguous", "warning", `${f.field} '${f.value}' resolves both document-relative and bundle-relative.`,
          `Write it bundle-absolute: '/${f.resolution.resolved}' or '/${f.resolution.ambiguous}'.`);
      } else if (!f.resolution.exists) {
        at("path-broken", "info", `${f.field} '${f.value}' does not resolve inside the bundle.`);
      }
    } else if (f.resolution.kind === "outside") {
      at("path-outside-bundle", "warning", `${f.field} '${f.value}' points outside the bundle.`);
    }
  }

  // Attested Computation (§10).
  if (c.type === "Attested Computation" && typeof fm["runtime"] !== "string") {
    at("computation-missing-runtime", "warning", "An Attested Computation needs `runtime` (OKF §10.2).");
  }

  // Language policy and raw sources (DESIGN.md §4.8).
  const badFields = nonEnglishFrontmatterFields(fm);
  if (badFields.length > 0) {
    at("language-not-english", "error", `${badFields.join(", ")} must be English in every zone.`,
      "Romanize proper nouns; keep the original wording in `aliases` or `original_title`.");
  }
  if (c.zone === "curated") {
    const { violates, stats } = bodyIsNonEnglish(c.body, model.policy.non_english_threshold);
    if (violates) {
      at("language-not-english", "error",
        `Body is ${(stats.ratio * 100).toFixed(1)}% non-Latin letters; curated concepts must be English.`,
        "Translate to English, store the original with okf_ingest_raw, and cite it in `sources`.");
    }
  } else {
    if (c.type !== RAW_TYPE) at("raw-type", "error", `Concepts in a raw directory must have \`type: ${RAW_TYPE}\`.`);
    if (!isLanguageTag(fm["language"])) at("raw-language", "error", "Raw sources need `language` as a BCP 47 tag, e.g. `th`.");
    if (typeof fm["resource"] !== "string" || !fm["resource"].trim()) {
      at("raw-resource", "error", "Raw sources need `resource` naming the original material.");
    }
    if (typeof fm["content_sha256"] !== "string") {
      at("raw-hash-missing", "warning", "Raw source has no `content_sha256`; edits cannot be detected.",
        "Re-ingest it with okf_ingest_raw, or run 'Accept raw edit'.");
    } else if (rawBodyModified(fm, c.body)) {
      at("raw-modified", "error", "Raw body no longer matches `content_sha256`.",
        "Restore the original text, or have a person run 'Accept raw edit' if the change is intended.");
    }
  }
}

/** Diagnostics for the given concepts only (used to validate a single write). */
export function lintPaths(model: BundleModel, paths: readonly string[], options: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const p of paths) {
    const c = model.concepts.get(p);
    if (c) lintConcept(model, c, options, (d) => out.push(d));
  }
  return out;
}

export function countBySeverity(diagnostics: Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}
