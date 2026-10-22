// Plan a single-concept write (DESIGN.md §6 steps 4-9): check the request, build the new
// text, normalize links, stamp provenance, apply the guards and validate. Pure: the caller
// supplies the bundle model and current text, and performs the write if a plan comes back.
// Moves span several files and are planned in move.ts.

import { analyzeConcept, bundleResolver, type BundleModel, type Concept } from "./bundle";
import { applyBodyOps, BodyOpError, type BodyOp } from "./bodyOps";
import { isReservedFilename, strictConceptIdErrors } from "./conceptId";
import { detectEol, parseConcept } from "./document";
import { editConcept, renderNewConcept } from "./edit";
import { deepEqual } from "./frontmatter";
import { bodyIsNonEnglish, isLanguageTag, nonEnglishFrontmatterFields, scriptStats } from "./language";
import { extractFootnotes } from "./links";
import { lintPaths, type Diagnostic } from "./lint";
import type { LogAction } from "./logRender";
import { normalizeBodyLinks, normalizeFieldPaths, resolveReference } from "./normalize";
import { findSection } from "./outline";
import { encodeLinkTarget, normalizePath, relativePath } from "./paths";
import { applyFrontmatterPatch, type FrontmatterPatch } from "./patch";
import { zoneOf } from "./policy";
import { RAW_TYPE, rawContentHash } from "./raw";
import { sha256Hex } from "./sha256";
import { normalizeSources } from "./sources";
import { isIsoDateTimeWithOffset, lifecycleStatus, normalizeVerified, okfNow, STATUSES, type Status } from "./trust";

export type WriteErrorCode = "invalid-argument" | "not-found" | "exists" | "conflict" | "forbidden" | "policy";

export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message: string,
    readonly hint?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Fields only the server writes (DESIGN.md §4.3). */
export const SERVER_OWNED_KEYS = ["generated", "verified", "content_sha256", "review_requested"] as const;
/** Fields that define an Attested Computation (OKF §10.2). */
export const COMPUTATION_KEYS = ["runtime", "parameters", "computation", "executor", "attester"] as const;
/** Changes to these alone do not count as a content change for `generated`. */
const NON_CONTENT_KEYS = new Set(["verified", "aliases", "generated"]);

export const MAX_CURATED_BYTES = 512 * 1024;
export const MAX_RAW_BYTES = 1024 * 1024;
const SHRINK_MIN_CHARS = 400;

export interface WriteContext {
  model: BundleModel;
  /** Actor stamped into `generated.by`, e.g. "claude-code/opus-5.5" or "process:nightly". */
  actor: string;
  can: (scope: string) => boolean;
  now: Date;
  /** Current text of a path, from the editor buffer when the file is open. */
  textOf?: (path: string) => string | undefined;
}

export type WriteRequest =
  | { kind: "create"; conceptId: string; frontmatter: Record<string, unknown>; body: string; reason?: string }
  | {
      kind: "update";
      conceptId: string;
      ifMatch: string;
      reason: string;
      patch?: FrontmatterPatch;
      /** Complete replacement frontmatter (repairs, or callers that send it whole). */
      frontmatter?: Record<string, unknown>;
      body?: string;
      bodyOps?: BodyOp[];
      allowShrink?: boolean;
    }
  | {
      kind: "ingest_raw";
      slug: string;
      dir?: string;
      title: string;
      description: string;
      language: string;
      resource: string;
      originalTitle?: string;
      originalFormat?: string;
      retrievedAt?: string;
      tags?: string[];
      body: string;
      replace?: boolean;
      ifMatch?: string;
      reason?: string;
    }
  | { kind: "deprecate"; conceptId: string; ifMatch?: string; replacedBy?: string; reason: string }
  | { kind: "publish"; conceptId: string; ifMatch: string; reason: string }
  /** Add a verification; with approve (a person only) also draft -> stable. */
  | { kind: "verify"; conceptId: string; ifMatch?: string; note?: string; approve?: boolean }
  | { kind: "request_review"; conceptId: string; note: string }
  /** A person accepts edits to a raw source's text (re-records content_sha256). */
  | { kind: "rehash"; conceptId: string; ifMatch?: string }
  /** Record a person's edit in `generated`. */
  | { kind: "stamp"; conceptId: string }
  | { kind: "convert_links"; conceptId: string };

export interface WritePlan {
  conceptId: string;
  path: string;
  /** Text before the write; null for a new file. */
  before: string | null;
  after: string;
  changed: boolean;
  action: LogAction;
  title: string;
  reason?: string;
  warnings: string[];
  /** For ingest: an identical raw source that already exists. */
  duplicateOf?: string;
}

export function etagOf(text: string): string {
  return sha256Hex(text);
}

/** Bundle path for a caller-supplied concept id. */
export function pathForId(conceptId: string): string {
  const raw = conceptId.trim();
  if (raw === "" || /[\\:\0]/.test(raw)) throw new WriteError("invalid-argument", `'${conceptId}' is not a valid concept id`);
  const n = normalizePath(raw.replace(/^\/+/, ""));
  if (n === null || n === "") throw new WriteError("invalid-argument", `'${conceptId}' points outside the bundle`);
  return n.endsWith(".md") ? n : `${n}.md`;
}

function checkReason(reason: string | undefined, required: boolean): string | undefined {
  const r = reason?.replace(/\s+/g, " ").trim();
  if (!r) {
    if (required) throw new WriteError("invalid-argument", "`reason` is required for this change", "Say in one English sentence why the change is made; it goes into log.md.");
    return undefined;
  }
  if (r.length > 500) throw new WriteError("invalid-argument", "`reason` is longer than 500 characters");
  if (scriptStats(r).nonLatin > 0) throw new WriteError("policy", "`reason` must be English: log.md is English (DESIGN.md §4.8)");
  return r;
}

function textOf(ctx: WriteContext, path: string): string | undefined {
  return ctx.textOf?.(path) ?? ctx.model.files.get(path);
}

function existing(ctx: WriteContext, path: string): { concept: Concept; text: string } {
  const concept = ctx.model.concepts.get(path);
  if (!concept) {
    const reserved = ctx.model.reserved.has(path);
    throw new WriteError("not-found", `Concept '${path.replace(/\.md$/, "")}' does not exist`, reserved ? "index.md and log.md are maintained by the server." : "Use okf_create for a new concept.");
  }
  return { concept, text: textOf(ctx, path) ?? "" };
}

function checkIfMatch(text: string, ifMatch: string | undefined, required: boolean): void {
  if (ifMatch === undefined || ifMatch === "") {
    if (required) throw new WriteError("invalid-argument", "`if_match` is required", "Read the concept with okf_read and pass its etag.");
    return;
  }
  const current = etagOf(text);
  if (ifMatch !== current) {
    throw new WriteError("conflict", "The concept changed since you read it", "Read it again with okf_read, merge your change into the current text, and retry with the new etag.", { etag: current });
  }
}

function checkServerOwnedInput(input: Record<string, unknown> | undefined, current: Record<string, unknown>, isCreate: boolean): void {
  if (!input) return;
  for (const key of SERVER_OWNED_KEYS) {
    if (!(key in input)) continue;
    if (isCreate || input[key] === null || !deepEqual(input[key], current[key])) {
      throw new WriteError("forbidden", `\`${key}\` is written only by the server`, "Leave it out; the server records provenance and verification itself.");
    }
  }
}

function checkStatusTransition(current: Status | null, nextRaw: unknown, ctx: WriteContext): void {
  const next = nextRaw === undefined || nextRaw === null ? "stable" : nextRaw;
  if (!STATUSES.includes(next as Status)) throw new WriteError("invalid-argument", `status '${String(nextRaw)}' is not draft, stable or deprecated`);
  if (next === current) return;
  if (next === "stable") throw new WriteError("forbidden", "Only a person (Approve in Obsidian) or okf_publish can make a concept stable", ctx.can("publish") ? "Use okf_publish." : "Leave status as draft; a person reviews drafts in Obsidian.");
  if (next === "deprecated") throw new WriteError("invalid-argument", "Use okf_deprecate to deprecate a concept");
}

function sectionText(body: string, name: string): string | null {
  const s = findSection(body, [name]);
  return "error" in s ? null : s.text;
}

function checkComputation(before: Record<string, unknown> | null, after: Record<string, unknown>, bodyBefore: string | null, bodyAfter: string, ctx: WriteContext): void {
  const isAC = (fm: Record<string, unknown> | null) => fm?.["type"] === "Attested Computation";
  if (!isAC(before) && !isAC(after)) return;
  if (ctx.can("computations:write")) return;
  const changed =
    before === null ||
    isAC(before) !== isAC(after) ||
    COMPUTATION_KEYS.some((k) => !deepEqual(before[k], after[k])) ||
    sectionText(bodyBefore ?? "", "Computation") !== sectionText(bodyAfter, "Computation");
  if (changed) {
    throw new WriteError("forbidden", "Authoring or changing a sanctioned computation needs the computations:write scope (OKF §10.3)", "Change only the prose around it, or ask the vault owner.");
  }
}

function schemaFields(body: string): Set<string> {
  const s = sectionText(body, "Schema");
  return new Set(s ? [...s.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)].map((m) => m[1]!) : []);
}

function checkNonDestructive(beforeFm: Record<string, unknown>, afterFm: Record<string, unknown>, beforeBody: string, afterBody: string): void {
  const problems: string[] = [];
  const sb = normalizeSources(beforeFm).length;
  const sa = normalizeSources(afterFm).length;
  if (sa < sb) problems.push(`sources would drop from ${sb} to ${sa}`);
  const fb = extractFootnotes(beforeBody);
  const fa = extractFootnotes(afterBody);
  const lost = [...fb.definitions].filter((d) => !fa.definitions.has(d) && fa.references.has(d));
  if (lost.length) problems.push(`footnote definitions removed while still cited: ${lost.join(", ")}`);
  const schemaLost = [...schemaFields(beforeBody)].filter((f) => !schemaFields(afterBody).has(f));
  if (schemaLost.length) problems.push(`# Schema would lose ${schemaLost.slice(0, 10).join(", ")}`);
  if (beforeBody.length >= SHRINK_MIN_CHARS && afterBody.length < beforeBody.length / 2) {
    problems.push(`body would shrink from ${beforeBody.length} to ${afterBody.length} characters`);
  }
  if (problems.length) {
    throw new WriteError("policy", `Refusing a destructive change: ${problems.join("; ")}`, "Merge with the existing content (okf_read first), or pass allow_shrink with a reason if the removal is intended.");
  }
}

function checkLanguage(model: BundleModel, path: string, fm: Record<string, unknown>, body: string | null): void {
  const bad = nonEnglishFrontmatterFields(fm);
  if (bad.length) {
    throw new WriteError("policy", `${bad.join(", ")} must be English`, "Romanize proper nouns; keep original wording in `aliases` or `original_title` (DESIGN.md §4.8).");
  }
  if (body !== null && zoneOf(path, model.policy) === "curated") {
    const { violates, stats } = bodyIsNonEnglish(body, model.policy.non_english_threshold);
    if (violates) {
      throw new WriteError("policy", `Curated concepts are English; this body is ${(stats.ratio * 100).toFixed(1)}% non-Latin letters`, "Translate it to English, store the original with okf_ingest_raw, and cite it in `sources`.");
    }
  }
}

function checkSize(path: string, text: string, zone: "curated" | "raw"): void {
  const bytes = new TextEncoder().encode(text).length;
  const max = zone === "raw" ? MAX_RAW_BYTES : MAX_CURATED_BYTES;
  if (bytes > max) {
    throw new WriteError("policy", `${path} would be ${Math.round(bytes / 1024)} KiB, over the ${max / 1024} KiB limit`, zone === "raw" ? "Split the source into parts, e.g. <slug>-part-01." : "Split the concept into smaller linked concepts.");
  }
}

/** Errors this write introduces (lint errors the concept did not already have). */
function validate(ctx: WriteContext, path: string, after: string, before: string | null): string[] {
  const files = new Map(ctx.model.files);
  files.set(path, after);
  // Only the written concept is analyzed: lintPaths reads that concept, the zones of what it
  // points at and the policy, all of which ctx.model already holds for the rest of the bundle.
  const concepts = new Map(ctx.model.concepts);
  if (!isReservedFilename(path)) concepts.set(path, analyzeConcept(path, after, bundleResolver(files, ctx.model.policy)).concept);
  const model: BundleModel = { ...ctx.model, files, concepts };
  const now = { now: ctx.now };
  const afterDiags = lintPaths(model, [path], now);
  const beforeCodes = new Set(before === null ? [] : lintPaths(ctx.model, [path], now).map((d) => `${d.severity}:${d.code}`));
  const fresh = (d: Diagnostic) => !beforeCodes.has(`${d.severity}:${d.code}`);
  const errors = afterDiags.filter((d) => d.severity === "error" && fresh(d));
  if (errors.length) {
    throw new WriteError("invalid-argument", `The result would not be valid: ${errors.map((d) => `[${d.code}] ${d.message}`).join("; ")}`, errors[0]!.fix_hint);
  }
  // Every warning the result still has, not only new ones: an agent that tried a fix must hear it did not work.
  return afterDiags.filter((d) => d.severity === "warning").map((d) => `[${d.code}] ${d.message}`);
}

function stamp(fm: Record<string, unknown>, ctx: WriteContext): Record<string, unknown> {
  return { ...fm, generated: { by: ctx.actor, at: okfNow(ctx.now) } };
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !deepEqual(a[k], b[k]));
}

function titleOf(fm: Record<string, unknown>, path: string): string {
  return typeof fm["title"] === "string" && fm["title"].trim() ? fm["title"] : path.replace(/\.md$/, "").split("/").pop()!;
}

export function planWrite(req: WriteRequest, ctx: WriteContext): WritePlan {
  switch (req.kind) {
    case "create":
      return planCreate(req, ctx);
    case "update":
      return planUpdate(req, ctx);
    case "ingest_raw":
      return planIngest(req, ctx);
    case "deprecate":
      return planDeprecate(req, ctx);
    case "publish":
      return planPublish(req, ctx);
    case "verify":
      return planVerify(req, ctx);
    case "request_review":
      return planRequestReview(req, ctx);
    case "rehash":
      return planRehash(req, ctx);
    case "stamp":
      return planStamp(req, ctx);
    case "convert_links":
      return planConvertLinks(req, ctx);
  }
}

function planCreate(req: Extract<WriteRequest, { kind: "create" }>, ctx: WriteContext): WritePlan {
  const path = pathForId(req.conceptId);
  const idErrors = strictConceptIdErrors(path.replace(/\.md$/, ""));
  if (idErrors.length) throw new WriteError("invalid-argument", `Concept id: ${idErrors.join("; ")}`, "Use lowercase English words joined by '-', e.g. 'concepts/remote-sensing'.");
  if (ctx.model.files.has(path)) throw new WriteError("exists", `'${req.conceptId}' already exists`, "Use okf_update to change it.");
  if (zoneOf(path, ctx.model.policy) === "raw") throw new WriteError("policy", "Raw sources are added with okf_ingest_raw", "Use okf_ingest_raw for original material.");
  const reason = checkReason(req.reason, false);
  checkServerOwnedInput(req.frontmatter, {}, true);
  if (typeof req.frontmatter["type"] !== "string" || !req.frontmatter["type"].trim()) {
    throw new WriteError("invalid-argument", "`type` is required (OKF §4.1)", "Give a short type such as Concept, Metric, Playbook or Decision.");
  }
  if (req.frontmatter["type"] === RAW_TYPE) throw new WriteError("policy", "Raw sources are added with okf_ingest_raw");
  const initial = ctx.model.policy.agent_initial_status;
  const status = req.frontmatter["status"] ?? initial;
  if (status === "deprecated" || !STATUSES.includes(status as Status)) throw new WriteError("invalid-argument", `A new concept cannot start as '${typeof status === "string" ? status : JSON.stringify(status)}'`);
  if (status === "stable" && initial !== "stable" && !ctx.can("publish")) {
    throw new WriteError("forbidden", "New concepts from agents start as draft", "Leave status out; a person approves drafts in Obsidian.");
  }

  const warnings: string[] = [];
  const fmNorm = normalizeFieldPaths(req.frontmatter, Object.keys(req.frontmatter), path, ctx.model);
  const bodyNorm = normalizeBodyLinks(req.body.replace(/\r\n/g, "\n"), path, ctx.model);
  const errors = [...fmNorm.errors, ...bodyNorm.errors];
  if (errors.length) throw new WriteError("invalid-argument", errors.join("; "));
  warnings.push(...fmNorm.warnings, ...bodyNorm.warnings);

  const fm = stamp({ ...fmNorm.value, status }, ctx);
  checkLanguage(ctx.model, path, fm, bodyNorm.value);
  checkComputation(null, fm, null, bodyNorm.value, ctx);
  const after = renderNewConcept(fm, bodyNorm.value);
  checkSize(path, after, "curated");
  warnings.push(...validate(ctx, path, after, null));
  return { conceptId: path.replace(/\.md$/, ""), path, before: null, after, changed: true, action: "Creation", title: titleOf(fm, path), ...(reason ? { reason } : {}), warnings };
}

function planUpdate(req: Extract<WriteRequest, { kind: "update" }>, ctx: WriteContext): WritePlan {
  const path = pathForId(req.conceptId);
  const { concept, text } = existing(ctx, path);
  checkIfMatch(text, req.ifMatch, true);
  const reason = checkReason(req.reason, true)!;
  if (req.frontmatter && req.patch) throw new WriteError("invalid-argument", "Pass either `frontmatter` (whole) or a patch, not both");
  if (req.body !== undefined && req.bodyOps?.length) throw new WriteError("invalid-argument", "Pass either `body` or `body_ops`, not both");

  let current: Record<string, unknown>;
  let broken = false;
  let currentBody: string;
  try {
    const parsed = parseConcept(text);
    current = parsed.frontmatter;
    currentBody = parsed.body;
  } catch {
    if (!req.frontmatter || req.body === undefined) {
      throw new WriteError("invalid-argument", "The concept's frontmatter does not parse, so it can only be replaced whole", "Send the complete `frontmatter` and `body`.");
    }
    current = {};
    currentBody = concept.body;
    broken = true;
  }

  checkServerOwnedInput(req.patch?.merge, current, false);
  checkServerOwnedInput(req.frontmatter, current, false);
  let next = req.frontmatter
    ? { ...req.frontmatter, ...Object.fromEntries(SERVER_OWNED_KEYS.filter((k) => k in current).map((k) => [k, current[k]])) }
    : applyFrontmatterPatch(current, req.patch ?? {});

  const warnings: string[] = [];
  let body = currentBody;
  try {
    if (req.body !== undefined) {
      const n = normalizeBodyLinks(req.body.replace(/\r\n/g, "\n"), path, ctx.model);
      if (n.errors.length) throw new WriteError("invalid-argument", n.errors.join("; "));
      warnings.push(...n.warnings);
      body = n.value;
    } else if (req.bodyOps?.length) {
      const ops = req.bodyOps.map((op) => {
        if (!("content" in op)) return op;
        const n = normalizeBodyLinks(op.content.replace(/\r\n/g, "\n"), path, ctx.model);
        if (n.errors.length) throw new WriteError("invalid-argument", n.errors.join("; "));
        warnings.push(...n.warnings);
        return { ...op, content: n.value };
      });
      body = applyBodyOps(currentBody, ops);
    }
  } catch (e) {
    if (e instanceof BodyOpError) throw new WriteError("not-found", e.message, "Call okf_read with view 'outline' to see heading paths.");
    throw e;
  }

  const keys = changedKeys(current, next);
  const fp = normalizeFieldPaths(next, keys, path, ctx.model);
  if (fp.errors.length) throw new WriteError("invalid-argument", fp.errors.join("; "));
  warnings.push(...fp.warnings);
  next = fp.value;

  const bodyChanged = body !== currentBody;
  const contentKeys = changedKeys(current, next).filter((k) => !NON_CONTENT_KEYS.has(k));
  if (!bodyChanged && changedKeys(current, next).length === 0) {
    return { conceptId: concept.id, path, before: text, after: text, changed: false, action: "Update", title: concept.title, reason, warnings: ["nothing changed"] };
  }

  checkStatusTransition(lifecycleStatus(current), next["status"], ctx);
  if (concept.zone === "raw") {
    if (bodyChanged) throw new WriteError("forbidden", "Raw sources are write-once", "To replace the original, call okf_ingest_raw with replace (needs raw:write).");
    if (next["type"] !== RAW_TYPE) throw new WriteError("invalid-argument", `Concepts in a raw directory keep type '${RAW_TYPE}'`);
  }
  checkComputation(current, next, currentBody, body, ctx);
  if (!req.allowShrink) checkNonDestructive(current, next, currentBody, body);
  if (bodyChanged || contentKeys.length > 0) next = stamp(next, ctx);

  const englishFieldsChanged = ["title", "description", "tags"].some((k) => !deepEqual(current[k], next[k]));
  checkLanguage(ctx.model, path, englishFieldsChanged ? next : {}, bodyChanged ? body : null);
  // A document whose YAML does not parse cannot be spliced; it is rewritten whole, keeping
  // its line endings.
  const after = broken
    ? renderNewConcept(next, body, detectEol(text))
    : editConcept(text, { frontmatter: next, ...(bodyChanged ? { body } : {}) });
  checkSize(path, after, concept.zone);
  warnings.push(...validate(ctx, path, after, text));
  return { conceptId: concept.id, path, before: text, after, changed: true, action: "Update", title: titleOf(next, path), reason, warnings };
}

function planIngest(req: Extract<WriteRequest, { kind: "ingest_raw" }>, ctx: WriteContext): WritePlan {
  const policy = ctx.model.policy;
  const dir = (req.dir ?? policy.raw_dirs[0] ?? "").replace(/^\/+|\/+$/g, "");
  if (!policy.raw_dirs.includes(dir)) {
    throw new WriteError("invalid-argument", `'${dir}' is not a raw directory of this bundle`, `Use one of: ${policy.raw_dirs.join(", ")}.`);
  }
  const slugErrors = strictConceptIdErrors(req.slug);
  if (slugErrors.length) throw new WriteError("invalid-argument", `slug: ${slugErrors.join("; ")}`, "Use lowercase English words joined by '-', e.g. 'acme-annual-report-2025'.");
  const path = `${dir}/${req.slug}.md`;
  if (!isLanguageTag(req.language)) throw new WriteError("invalid-argument", `language ${JSON.stringify(req.language)} is not a BCP 47 tag`, "For example 'th', 'en' or 'ja'.");
  if (!req.resource?.trim()) throw new WriteError("invalid-argument", "`resource` (where the original came from) is required");
  if (req.retrievedAt !== undefined && !isIsoDateTimeWithOffset(req.retrievedAt)) {
    throw new WriteError("invalid-argument", "`retrieved_at` must be an ISO 8601 datetime with an offset");
  }
  const reason = checkReason(req.reason, Boolean(req.replace));

  const fm: Record<string, unknown> = {
    type: RAW_TYPE,
    title: req.title,
    description: req.description,
    resource: req.resource,
    language: req.language,
    ...(req.tags?.length ? { tags: req.tags } : {}),
    ...(req.originalTitle ? { original_title: req.originalTitle } : {}),
    ...(req.originalFormat ? { original_format: req.originalFormat } : {}),
    ...(req.retrievedAt ? { retrieved_at: req.retrievedAt } : {}),
  };
  checkLanguage(ctx.model, path, fm, null);

  // The original is stored as given: no link normalization, so it stays a faithful copy.
  const draft = renderNewConcept(stamp(fm, ctx), req.body);
  const hash = rawContentHash(parseConcept(draft).body);
  const duplicate = [...ctx.model.concepts.values()].find((c) => c.zone === "raw" && c.frontmatter["content_sha256"] === hash);
  if (duplicate && duplicate.path !== path) {
    return { conceptId: duplicate.id, path: duplicate.path, before: textOf(ctx, duplicate.path) ?? null, after: textOf(ctx, duplicate.path) ?? "", changed: false, action: "Ingest", title: duplicate.title, warnings: ["identical content already ingested"], duplicateOf: duplicate.id };
  }

  const current = textOf(ctx, path);
  if (current !== undefined) {
    if (duplicate?.path === path) {
      return { conceptId: duplicate.id, path, before: current, after: current, changed: false, action: "Ingest", title: duplicate.title, warnings: ["identical content already ingested"], duplicateOf: duplicate.id };
    }
    if (!req.replace) throw new WriteError("exists", `'${path.replace(/\.md$/, "")}' already exists`, "Pick another slug, or pass replace with if_match (needs raw:write).");
    if (!ctx.can("raw:write")) throw new WriteError("forbidden", "Replacing a raw source needs the raw:write scope");
    checkIfMatch(current, req.ifMatch, true);
  }

  const after = editConcept(draft, { frontmatter: { ...parseConcept(draft).frontmatter, content_sha256: hash } });
  checkSize(path, after, "raw");
  const warnings = validate(ctx, path, after, current ?? null);
  return { conceptId: path.replace(/\.md$/, ""), path, before: current ?? null, after, changed: true, action: "Ingest", title: req.title, ...(reason ? { reason } : {}), warnings };
}

function planDeprecate(req: Extract<WriteRequest, { kind: "deprecate" }>, ctx: WriteContext): WritePlan {
  const path = pathForId(req.conceptId);
  const { concept, text } = existing(ctx, path);
  checkIfMatch(text, req.ifMatch, false);
  const reason = checkReason(req.reason, true)!;
  if (concept.status === "deprecated") {
    return { conceptId: concept.id, path, before: text, after: text, changed: false, action: "Deprecation", title: concept.title, reason, warnings: ["already deprecated"] };
  }
  let body = concept.body;
  if (req.replacedBy) {
    const r = resolveReference(ctx.model, path, req.replacedBy);
    if (!("path" in r) || !ctx.model.concepts.has(r.path)) throw new WriteError("not-found", `replaced_by '${req.replacedBy}' is not an existing concept`);
    if (r.path === path) throw new WriteError("invalid-argument", "A concept cannot replace itself");
    const target = ctx.model.concepts.get(r.path)!;
    const line = `> **Deprecated:** superseded by [${target.title.replace(/([[\]])/g, "\\$1")}](${encodeLinkTarget(relativePath(path, r.path))}).`;
    if (!body.includes(line)) body = `\n${line}\n${body.startsWith("\n") ? "" : "\n"}${body}`;
  }
  const next = stamp({ ...concept.frontmatter, status: "deprecated" }, ctx);
  const after = editConcept(text, { frontmatter: next, body });
  const warnings = validate(ctx, path, after, text);
  return { conceptId: concept.id, path, before: text, after, changed: true, action: "Deprecation", title: concept.title, reason, warnings };
}

/** Changes that do not touch content keep `generated`; only the given keys change. */
function planMeta(
  ctx: WriteContext,
  conceptId: string,
  ifMatch: string | undefined,
  action: LogAction,
  reason: string | undefined,
  change: (concept: Concept) => { frontmatter?: Record<string, unknown>; body?: string } | null,
): WritePlan {
  const path = pathForId(conceptId);
  const { concept, text } = existing(ctx, path);
  checkIfMatch(text, ifMatch, false);
  const edit = change(concept);
  if (edit === null) return { conceptId: concept.id, path, before: text, after: text, changed: false, action, title: concept.title, ...(reason ? { reason } : {}), warnings: ["nothing changed"] };
  const after = editConcept(text, edit);
  const warnings = validate(ctx, path, after, text);
  return { conceptId: concept.id, path, before: text, after, changed: after !== text, action, title: concept.title, ...(reason ? { reason } : {}), warnings };
}

function humanOnly(ctx: WriteContext, what: string): void {
  if (!ctx.can("human")) throw new WriteError("forbidden", `${what} is done by a person in Obsidian`);
}

function planVerify(req: Extract<WriteRequest, { kind: "verify" }>, ctx: WriteContext): WritePlan {
  // Approving is verify plus publish, so a process holding both may do it (the auto approver).
  if (req.approve) {
    if (!(ctx.can("verify") && ctx.can("publish"))) humanOnly(ctx, "Approving");
  } else if (!ctx.can("verify")) throw new WriteError("forbidden", "Verifying needs the verify scope");
  const reason = checkReason(req.note, false);
  return planMeta(ctx, req.conceptId, req.ifMatch, req.approve ? "Approval" : "Verification", reason, (c) => {
    const fm: Record<string, unknown> = { ...c.frontmatter, verified: [...normalizeVerified(c.frontmatter), { by: ctx.actor, at: okfNow(ctx.now) }] };
    if (req.approve) {
      if (c.status === "draft") fm["status"] = "stable";
      delete fm["review_requested"];
    }
    return { frontmatter: fm };
  });
}

function planRequestReview(req: Extract<WriteRequest, { kind: "request_review" }>, ctx: WriteContext): WritePlan {
  const note = checkReason(req.note, true)!;
  return planMeta(ctx, req.conceptId, undefined, "Review request", note, (c) => ({
    frontmatter: { ...c.frontmatter, review_requested: { by: ctx.actor, at: okfNow(ctx.now), note } },
  }));
}

function planRehash(req: Extract<WriteRequest, { kind: "rehash" }>, ctx: WriteContext): WritePlan {
  humanOnly(ctx, "Accepting an edited raw source");
  return planMeta(ctx, req.conceptId, req.ifMatch, "Update", "Accepted edits to the raw source text.", (c) => {
    if (c.zone !== "raw") throw new WriteError("invalid-argument", "Only raw sources carry a content hash");
    const hash = rawContentHash(c.body);
    return c.frontmatter["content_sha256"] === hash ? null : { frontmatter: stamp({ ...c.frontmatter, content_sha256: hash }, ctx) };
  });
}

function planStamp(req: Extract<WriteRequest, { kind: "stamp" }>, ctx: WriteContext): WritePlan {
  humanOnly(ctx, "Recording a person's edit");
  return planMeta(ctx, req.conceptId, undefined, "Update", "Edited in Obsidian.", (c) => ({ frontmatter: stamp(c.frontmatter, ctx) }));
}

function planConvertLinks(req: Extract<WriteRequest, { kind: "convert_links" }>, ctx: WriteContext): WritePlan {
  humanOnly(ctx, "Converting links");
  // A mechanical rewrite: `generated` is kept so verifications do not look outdated.
  return planMeta(ctx, req.conceptId, undefined, "Update", "Converted links to OKF form.", (c) => {
    const n = normalizeBodyLinks(c.body, c.path, ctx.model);
    if (n.errors.length) throw new WriteError("invalid-argument", n.errors.join("; "));
    return n.value === c.body ? null : { body: n.value };
  });
}

function planPublish(req: Extract<WriteRequest, { kind: "publish" }>, ctx: WriteContext): WritePlan {
  if (!ctx.can("publish")) throw new WriteError("forbidden", "Publishing needs the publish scope", "A person approves drafts in Obsidian.");
  const path = pathForId(req.conceptId);
  const { concept, text } = existing(ctx, path);
  checkIfMatch(text, req.ifMatch, true);
  const reason = checkReason(req.reason, true)!;
  if (concept.status !== "draft") throw new WriteError("invalid-argument", `Only drafts can be published; this concept is ${concept.status ?? "invalid"}`);
  // A status change is not a content change, so `generated` is left as it is.
  const after = editConcept(text, { frontmatter: { ...concept.frontmatter, status: "stable" } });
  const warnings = validate(ctx, path, after, text);
  return { conceptId: concept.id, path, before: text, after, changed: true, action: "Publication", title: concept.title, reason, warnings };
}
