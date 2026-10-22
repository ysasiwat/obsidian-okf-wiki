// Read-side queries over the exposed bundles (DESIGN.md §7.1). Every result is filtered
// by the caller's bundle and path allowlist, including backlinks and graph neighbours,
// so a token never learns that a concept outside its scope exists.

import { isHiddenPath, type BundleModel, type Concept, type Edge } from "../core/bundle";
import { indexedDirectories, parseIndexEntryInfo, type IndexEntryInfo } from "../core/indexRender";
import { lintBundle, warmLint, type Diagnostic, type Severity } from "../core/lint";
import { extractFootnotes } from "../core/links";
import { parseLog } from "../core/logRender";
import { extractHeadings, findSection } from "../core/outline";
import { basename, dirname, isUrl, joinPath, normalizePath } from "../core/paths";
import { ConceptSearch, snippet, type SearchDocument } from "../core/search";
import { sha256Hex } from "../core/sha256";
import { normalizeSources } from "../core/sources";
import { normalizeTags } from "../core/tags";
import { isStale, normalizeVerified, trustFingerprint, trustTier, TRUST_RANK, verificationOutdated, type Status, type TrustTier } from "../core/trust";
import { ServiceError, type BundleHandle, type BundleProvider, type Principal, type TrustLedger } from "./types";

export const DEFAULT_READ_CHARS = 20_000;
export const MAX_READ_CHARS = 100_000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const MAX_GRAPH_NODES = 200;
const MAX_LINK_LIST = 100;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  if (!/^\d{1,9}$/.test(decoded)) {
    throw new ServiceError("invalid-argument", "cursor is invalid", "Pass the next_cursor value from the previous result unchanged.");
  }
  return Number(decoded);
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT));
}

function page<T>(items: T[], limit: number | undefined, cursor: string | undefined): { items: T[]; next_cursor?: string; total: number } {
  const offset = decodeCursor(cursor);
  const n = clampLimit(limit);
  const slice = items.slice(offset, offset + n);
  return { items: slice, total: items.length, ...(offset + n < items.length ? { next_cursor: encodeCursor(offset + n) } : {}) };
}

/** Text files okf_read_file serves; anything else (images, archives, binaries) is refused. */
export const TEXT_FILE_EXTENSIONS: readonly string[] = [".py", ".sql", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".toml", ".ini", ".xml", ".js", ".ts", ".sh", ".r"];

/** Normalize a caller-supplied concept id or path to a bundle path ending in .md. */
export function conceptPathFromInput(input: string): string {
  const normalized = bundlePathFromInput(input);
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

/** Normalize a caller-supplied bundle-relative path, refusing anything outside the bundle. */
export function bundlePathFromInput(input: string): string {
  const raw = input.trim();
  if (raw === "" || /[\\:\0]/.test(raw)) {
    throw new ServiceError("invalid-argument", `'${input}' is not a valid concept id`, "Use the bundle-relative id, e.g. 'tables/orders'.");
  }
  const normalized = normalizePath(raw.replace(/^\/+/, ""));
  if (normalized === null || normalized === "") {
    throw new ServiceError("invalid-argument", `'${input}' points outside the bundle`);
  }
  return normalized;
}

/** A search index and the model it reflects. */
interface Carried {
  index: ConceptSearch;
  model: BundleModel;
}

function searchDocument(c: Concept, zone: "curated" | "raw"): SearchDocument {
  return {
    id: c.path,
    title: c.title,
    description: c.description ?? "",
    tags: normalizeTags(c.frontmatter).join(" "),
    aliases: [c.frontmatter["aliases"], c.frontmatter["original_title"]].flat().filter((x) => typeof x === "string").join(" "),
    body: zone === "raw" ? c.body.slice(0, 200_000) : c.body,
  };
}

interface Cached {
  version: number;
  model: BundleModel;
  curated?: ConceptSearch;
  raw?: ConceptSearch;
  lint?: Diagnostic[];
  /** Indexes of an earlier version, updated rather than rebuilt when next needed. */
  carried: { curated?: Carried; raw?: Carried };
}

export type ReadView = "full" | "outline" | "frontmatter" | "section";

/** One shape for every view; fields that do not apply to a view are absent. */
export interface ReadResult extends ConceptSummary {
  bundle: string;
  path: string;
  etag: string;
  view: ReadView;
  verification_outdated: boolean;
  language: string | null;
  parse_error?: string;
  frontmatter?: Record<string, unknown>;
  outline?: { level: number; text: string; path: string[]; chars: number }[];
  body_chars?: number;
  footnotes?: string[];
  section?: string[];
  body?: string;
  offset?: number;
  total_chars?: number;
  truncated?: boolean;
  next_offset?: number;
  sources: Record<string, unknown>[];
  links: {
    outgoing: { target: string; kind: string; resolved: string | null; exists: boolean }[];
    backlinks: { concept_id: string; kind: string }[];
    backlinks_total: number;
    broken: string[];
  };
}

export interface ConceptSummary {
  concept_id: string;
  title: string;
  type: string | null;
  description: string | null;
  status: Status | null;
  trust_tier: TrustTier;
  stale: boolean;
  zone: "curated" | "raw";
  /** false: status or verified was changed outside the plugin (DESIGN.md §5.1); null: unknown. */
  trust_attested: boolean | null;
}

export class KnowledgeService {
  private cache = new Map<string, Cached>();

  constructor(
    private readonly provider: BundleProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly trust?: TrustLedger,
  ) {}

  /** Whether status and verified are as this plugin last wrote them; null when unknown. */
  private attested(bundle: string, c: Concept): boolean | null {
    const fp = this.trust?.get(bundle, c.path);
    return fp === undefined ? null : fp === trustFingerprint(c.frontmatter);
  }

  // ---- access control -------------------------------------------------------------

  private visibleBundles(p: Principal): BundleHandle[] {
    return this.provider.bundles().filter((b) => p.bundles === "*" || p.bundles.includes(b.name));
  }

  private pathAllowed(p: Principal, path: string): boolean {
    return p.pathPrefixes.length === 0 || p.pathPrefixes.some((pre) => path === pre || path.startsWith(pre.endsWith("/") ? pre : `${pre}/`));
  }

  private bundle(p: Principal, name: string | undefined): BundleHandle {
    if (!this.provider.ready() && this.provider.bundles().length === 0) {
      throw new ServiceError("not-ready", "Obsidian is still indexing the vault.", "Retry in a few seconds.");
    }
    const visible = this.visibleBundles(p);
    if (name === undefined || name === "") {
      if (visible.length === 1) return visible[0]!;
      throw new ServiceError(
        "ambiguous",
        visible.length === 0 ? "No bundles are available to this token." : `Several bundles are available: ${visible.map((b) => b.name).join(", ")}.`,
        visible.length === 0 ? "Ask the vault owner to grant this token a bundle." : "Pass `bundle` with one of these names.",
      );
    }
    const b = visible.find((x) => x.name === name);
    if (!b) {
      throw new ServiceError("not-found", `Bundle '${name}' does not exist or is not available to this token.`, "Call okf_bundles to list available bundles.");
    }
    return b;
  }

  private concept(p: Principal, b: BundleHandle, conceptId: string): Concept {
    const path = conceptPathFromInput(conceptId);
    const c = b.model.concepts.get(path);
    if (!c || !this.pathAllowed(p, path)) {
      const reserved = b.model.reserved.has(path);
      // An agent asking okf_read for attesters/x.py means the file, not a concept (eval round 2).
      const file = path.slice(0, -".md".length);
      const isFile = !file.endsWith(".md") && b.model.files.has(file) && this.pathAllowed(p, file);
      throw new ServiceError(
        "not-found",
        `Concept '${conceptId}' not found in bundle '${b.name}'.`,
        isFile ? `'${file}' is a file, not a concept; read it with okf_read_file.` : reserved ? "index.md and log.md are not concepts; use okf_browse or okf_history." : "Use okf_search or okf_browse to find concept ids.",
      );
    }
    return c;
  }

  private cached(b: BundleHandle): Cached {
    let c = this.cache.get(b.name);
    if (!c || c.version !== b.version) {
      const old = c;
      const carry = (zone: "curated" | "raw"): Carried | undefined => {
        const index = old?.[zone];
        return index ? { index, model: old.model } : old?.carried[zone];
      };
      c = { version: b.version, model: b.model, carried: { curated: carry("curated"), raw: carry("raw") } };
      this.cache.set(b.name, c);
    }
    return c;
  }

  private summary(c: Concept, bundle: string): ConceptSummary {
    return {
      trust_attested: this.attested(bundle, c),
      concept_id: c.id,
      title: c.title,
      type: c.type,
      description: c.description,
      status: c.status,
      trust_tier: trustTier(c.frontmatter),
      stale: isStale(c.frontmatter, this.now()),
      zone: c.zone,
    };
  }

  // ---- tools ----------------------------------------------------------------------

  status(p: Principal) {
    return {
      ready: this.provider.ready(),
      token: p.tokenName,
      scopes: [...p.scopes].sort(),
      bundles: this.visibleBundles(p).map((b) => b.name),
    };
  }

  listBundles(p: Principal) {
    return {
      ready: this.provider.ready(),
      bundles: this.visibleBundles(p).map((b) => {
        const concepts = [...b.model.concepts.values()].filter((c) => this.pathAllowed(p, c.path));
        const count = (key: (c: Concept) => string) => {
          const out: Record<string, number> = {};
          for (const c of concepts) out[key(c)] = (out[key(c)] ?? 0) + 1;
          return out;
        };
        const lint = this.lintAll(b).filter((d) => this.pathAllowed(p, d.path) || d.path === ".okf.yaml");
        return {
          name: b.name,
          okf_version: b.model.policy.okf_version,
          content_language: b.model.policy.content_language,
          raw_dirs: b.model.policy.raw_dirs,
          concepts: concepts.length,
          by_type: count((c) => c.type ?? "(none)"),
          by_status: count((c) => c.status ?? "(invalid)"),
          by_trust: count((c) => trustTier(c.frontmatter)),
          by_zone: count((c) => c.zone),
          lint: {
            error: lint.filter((d) => d.severity === "error").length,
            warning: lint.filter((d) => d.severity === "warning").length,
            info: lint.filter((d) => d.severity === "info").length,
          },
        };
      }),
    };
  }

  browse(p: Principal, args: { bundle?: string; dir?: string }) {
    const b = this.bundle(p, args.bundle);
    const dir = args.dir ? normalizePath(args.dir.replace(/^\/+/, "")) : "";
    if (dir === null) throw new ServiceError("invalid-argument", `'${args.dir}' points outside the bundle`);
    const dirs = indexedDirectories(b.model);
    if (dir !== "" && !dirs.includes(dir)) {
      throw new ServiceError("not-found", `Directory '${dir}' has no concepts in bundle '${b.name}'.`, "Browse the parent directory to see what exists.");
    }
    const existingIndex = b.model.reserved.get(dir === "" ? "index.md" : `${dir}/index.md`);
    const info = existingIndex ? parseIndexEntryInfo(existingIndex) : new Map<string, IndexEntryInfo>();
    const prefix = dir === "" ? "" : `${dir}/`;
    const visibleUnder = (d: string) =>
      [...b.model.concepts.values()].filter((c) => c.path.startsWith(`${d}/`) && this.pathAllowed(p, c.path));

    const subdirectories = dirs
      .filter((d) => d !== dir && dirname(d) === dir)
      .map((d) => ({ dir: d, concepts: visibleUnder(d).length, description: info.get(`${basename(d)}/index.md`)?.description || null }))
      .filter((d) => d.concepts > 0 || p.pathPrefixes.length === 0);
    const concepts = [...b.model.concepts.values()]
      .filter((c) => dirname(c.path) === dir && this.pathAllowed(p, c.path))
      .map((c) => this.summary(c, b.name))
      .sort((a, x) => a.title.localeCompare(x.title, "en"));
    const files = [...b.model.files.keys()]
      .filter((f) => f.startsWith(prefix) && dirname(f) === dir && !f.endsWith(".md") && !f.split("/").some((s) => s.startsWith(".")) && this.pathAllowed(p, f))
      .sort();
    return { bundle: b.name, dir, subdirectories, concepts, files };
  }

  read(
    p: Principal,
    args: { bundle?: string; concept_id: string; view?: ReadView; section?: string[]; offset?: number; max_chars?: number },
  ): ReadResult {
    const b = this.bundle(p, args.bundle);
    const c = this.concept(p, b, args.concept_id);
    const text = b.model.files.get(c.path) ?? "";
    const view = args.view ?? "full";
    const allowed = (path: string) => this.pathAllowed(p, path);

    const base = {
      bundle: b.name,
      path: c.path,
      etag: sha256Hex(text),
      ...this.summary(c, b.name),
      verification_outdated: verificationOutdated(c.frontmatter),
      language: typeof c.frontmatter["language"] === "string" ? (c.frontmatter["language"]) : c.zone === "curated" ? b.model.policy.content_language : null,
      ...(c.parseError ? { parse_error: c.parseError.message } : {}),
    };

    const outgoing = c.links.map((l) => ({ target: l.link.target, kind: l.link.kind, resolved: l.target && allowed(l.target) ? l.target.replace(/\.md$/, "") : null, exists: l.target !== null }));
    const backlinks = (b.model.backlinks.get(c.path) ?? []).filter((e) => allowed(e.from));
    const links: ReadResult["links"] = {
      outgoing: outgoing.slice(0, MAX_LINK_LIST),
      backlinks: backlinks.slice(0, MAX_LINK_LIST).map((e) => ({ concept_id: e.from.replace(/\.md$/, ""), kind: e.kind })),
      backlinks_total: backlinks.length,
      broken: outgoing.filter((l) => !l.exists && !isUrl(l.target)).map((l) => l.target),
    };
    const sources = normalizeSources(c.frontmatter).map((s, i) => {
      const fp = c.fieldPaths.find((f) => f.field === `sources[${i}].resource`);
      const resolved = fp?.target && allowed(fp.target) ? fp.target.replace(/\.md$/, "") : null;
      return { ...s, ...(resolved ? { resolved_concept_id: resolved } : {}) };
    });

    if (view === "frontmatter") return { ...base, view, frontmatter: c.frontmatter, sources, links };
    if (view === "outline") {
      const notes = extractFootnotes(c.body);
      return {
        ...base, view,
        outline: extractHeadings(c.body).map((h) => ({ level: h.level, text: h.text, path: h.path, chars: h.end - h.start })),
        body_chars: c.body.length,
        footnotes: [...notes.references].sort(),
        sources, links,
      };
    }
    if (view === "section") {
      if (!args.section || args.section.length === 0) {
        throw new ServiceError("invalid-argument", "view 'section' needs `section`, a heading path such as [\"Schema\"].", "Call okf_read with view 'outline' to see heading paths.");
      }
      const found = findSection(c.body, args.section);
      if ("error" in found) throw new ServiceError("not-found", found.error, "Call okf_read with view 'outline' to see heading paths.");
      return { ...base, view, section: found.heading.path, ...this.slice(found.text, args.offset, args.max_chars), sources, links };
    }
    return { ...base, view: "full" as const, frontmatter: c.frontmatter, ...this.slice(c.body, args.offset, args.max_chars), sources, links };
  }

  /** A non-markdown text file in a bundle, such as an attester's code (DESIGN.md §7.1, ADR 0007). */
  async readFile(p: Principal, args: { bundle?: string; path: string; offset?: number; max_chars?: number }) {
    const b = this.bundle(p, args.bundle);
    const path = bundlePathFromInput(args.path);
    if (path.endsWith(".md")) throw new ServiceError("invalid-argument", `'${args.path}' is markdown`, "Markdown files are concepts; read them with okf_read.");
    if (!b.model.files.has(path) || isHiddenPath(path) || !this.pathAllowed(p, path)) {
      throw new ServiceError("not-found", `File '${args.path}' not found in bundle '${b.name}'.`, "Use okf_browse to list a directory's files.");
    }
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
    if (!TEXT_FILE_EXTENSIONS.includes(ext)) {
      throw new ServiceError("invalid-argument", `'${args.path}' is not a text file this tool serves`, `Readable extensions: ${TEXT_FILE_EXTENSIONS.join(" ")}.`);
    }
    const text = this.provider.readText ? await this.provider.readText(b.name, path) : b.model.files.get(path) ?? null;
    if (text === null) throw new ServiceError("not-found", `File '${args.path}' could not be read`, "It may have moved, or its real location is outside the vault.");
    const { body, ...rest } = this.slice(text, args.offset, args.max_chars);
    return { bundle: b.name, path, text: body, ...rest };
  }

  private slice(text: string, offset = 0, maxChars = DEFAULT_READ_CHARS) {
    const max = Math.max(1, Math.min(MAX_READ_CHARS, maxChars));
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.min(text.length, start + max);
    return {
      body: text.slice(start, end),
      offset: start,
      total_chars: text.length,
      truncated: end < text.length,
      ...(end < text.length ? { next_offset: end } : {}),
    };
  }

  search(
    p: Principal,
    args: {
      query?: string; bundle?: string; type?: string; tags?: string[]; status?: Status[]; min_trust?: TrustTier;
      stale?: boolean; under?: string; include_raw?: boolean; unprocessed_raw?: boolean; language?: string;
      limit?: number; cursor?: string;
    },
  ) {
    const bundles = args.bundle ? [this.bundle(p, args.bundle)] : this.visibleBundles(p);
    const includeRaw = args.include_raw || args.unprocessed_raw;
    const statuses = new Set<Status | null>(args.status ?? ["draft", "stable"]);
    const under = args.under ? normalizePath(args.under.replace(/^\/+/, "")) : null;
    const now = this.now();

    const hits: (ConceptSummary & { bundle: string; score: number; snippet: string })[] = [];
    for (const b of bundles) {
      const keep = (c: Concept): boolean => {
        if (!this.pathAllowed(p, c.path)) return false;
        if (c.zone === "raw" && !includeRaw) return false;
        if (args.unprocessed_raw && (c.zone !== "raw" || this.isCitedByCurated(b.model, c.path))) return false;
        if (!statuses.has(c.status)) return false;
        if (args.type && (c.type ?? "").toLowerCase() !== args.type.toLowerCase()) return false;
        if (args.tags?.length) {
          const tags = normalizeTags(c.frontmatter).map((t) => t.toLowerCase());
          if (!args.tags.every((t) => tags.includes(t.toLowerCase()))) return false;
        }
        if (args.min_trust && TRUST_RANK[trustTier(c.frontmatter)] < TRUST_RANK[args.min_trust]) return false;
        if (args.stale !== undefined && isStale(c.frontmatter, now) !== args.stale) return false;
        if (under && !c.path.startsWith(`${under}/`)) return false;
        if (args.language) {
          const lang = typeof c.frontmatter["language"] === "string" ? c.frontmatter["language"] : c.zone === "curated" ? b.model.policy.content_language : "";
          if (String(lang).toLowerCase() !== args.language.toLowerCase()) return false;
        }
        return true;
      };
      const push = (c: Concept, score: number, terms: string[]) =>
        hits.push({ ...this.summary(c, b.name), bundle: b.name, score, snippet: snippet(c.body, terms) });

      if (args.query?.trim()) {
        for (const zone of includeRaw ? (["curated", "raw"] as const) : (["curated"] as const)) {
          for (const h of this.searchIndex(b, zone).search(args.query)) {
            const c = b.model.concepts.get(h.id);
            if (c && keep(c)) push(c, h.score, h.terms);
          }
        }
      } else {
        for (const c of b.model.concepts.values()) if (keep(c)) push(c, 0, []);
      }
    }
    if (args.query?.trim()) hits.sort((a, x) => x.score - a.score || a.concept_id.localeCompare(x.concept_id));
    else hits.sort((a, x) => a.bundle.localeCompare(x.bundle) || a.title.localeCompare(x.title, "en"));
    const pg = page(hits, args.limit, args.cursor);
    return { hits: pg.items.map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 })), total: pg.total, ...(pg.next_cursor ? { next_cursor: pg.next_cursor } : {}) };
  }

  private isCitedByCurated(model: BundleModel, path: string): boolean {
    return (model.backlinks.get(path) ?? []).some((e) => model.concepts.get(e.from)?.zone === "curated");
  }

  private searchIndex(b: BundleHandle, zone: "curated" | "raw"): ConceptSearch {
    const cache = this.cached(b);
    const existing = cache[zone];
    if (existing) return existing;
    const doc = (c: Concept) => searchDocument(c, zone);
    // Carry the previous version's index forward: unchanged files share their parsed
    // frontmatter object (analyzeBundle with a previous model), so only changed concepts are re-indexed.
    const carried = cache.carried[zone];
    const index = carried?.index ?? new ConceptSearch();
    if (carried) {
      for (const p of carried.model.concepts.values()) if (p.zone === zone && b.model.concepts.get(p.path)?.zone !== zone) index.remove(p.path);
    }
    for (const c of b.model.concepts.values()) {
      if (c.zone !== zone) continue;
      const p = carried?.model.concepts.get(c.path);
      if (!p || p.zone !== zone || p.frontmatter !== c.frontmatter || p.body !== c.body) index.upsert(doc(c));
    }
    delete cache.carried[zone];
    cache[zone] = index;
    return index;
  }

  /**
   * After a load, build what the first requests would otherwise build in one go: each bundle's lint
   * cache and, when there is none to update, its search indexes. Hands control back every `sliceMs`
   * (DESIGN.md §13 4A).
   */
  async warm(pause: () => Promise<void>, sliceMs = 16): Promise<void> {
    for (const b of this.provider.bundles()) {
      await warmLint(b.model, { now: this.now() }, pause, sliceMs);
      for (const zone of ["curated", "raw"] as const) {
        const cache = this.cached(b);
        if (cache[zone] || cache.carried[zone]) continue;
        const index = new ConceptSearch();
        let sliceStart = Date.now();
        for (const c of b.model.concepts.values()) {
          if (c.zone !== zone) continue;
          index.upsert(searchDocument(c, zone));
          if (Date.now() - sliceStart >= sliceMs) {
            await pause();
            sliceStart = Date.now();
          }
        }
        // Built from b.model, so it matches this cache entry; if the bundle moved on meanwhile, the
        // next version carries it forward and re-indexes only what changed.
        cache[zone] ??= index;
      }
    }
  }

  graph(p: Principal, args: { bundle?: string; concept_id: string; depth?: number; direction?: "out" | "in" | "both" }) {
    const b = this.bundle(p, args.bundle);
    const start = this.concept(p, b, args.concept_id);
    const depth = Math.max(1, Math.min(2, args.depth ?? 1));
    const dir = args.direction ?? "both";
    const allowed = (path: string) => this.pathAllowed(p, path) && b.model.concepts.has(path);
    const nodes = new Set<string>([start.path]);
    const edges: Edge[] = [];
    let frontier = [start.path];
    for (let d = 0; d < depth && nodes.size < MAX_GRAPH_NODES; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        const candidates = [
          ...(dir !== "in" ? b.model.edges.filter((e) => e.from === n) : []),
          ...(dir !== "out" ? (b.model.backlinks.get(n) ?? []) : []),
        ];
        for (const e of candidates) {
          if (!allowed(e.from) || !allowed(e.to)) continue;
          if (!edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) edges.push(e);
          const other = e.from === n ? e.to : e.from;
          if (!nodes.has(other) && nodes.size < MAX_GRAPH_NODES) {
            nodes.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return {
      bundle: b.name,
      center: start.id,
      nodes: [...nodes].map((n) => this.summary(b.model.concepts.get(n)!, b.name)),
      edges: edges.map((e) => ({ from: e.from.replace(/\.md$/, ""), to: e.to.replace(/\.md$/, ""), kind: e.kind })),
      truncated: nodes.size >= MAX_GRAPH_NODES,
    };
  }

  private lintAll(b: BundleHandle): Diagnostic[] {
    const cache = this.cached(b);
    cache.lint ??= [...lintBundle(b.model, { now: this.now() }), ...this.unattested(b)];
    return cache.lint;
  }

  /** Lint errors for trust changes made outside the plugin (DESIGN.md §5.1). */
  private unattested(b: BundleHandle): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const c of b.model.concepts.values()) {
      const fp = this.trust?.get(b.name, c.path);
      if (fp === undefined || fp === trustFingerprint(c.frontmatter)) continue;
      const was = JSON.parse(fp) as { status: unknown; verified: unknown };
      const now = JSON.parse(trustFingerprint(c.frontmatter)) as typeof was;
      const verifiedChanged = JSON.stringify(was.verified) !== JSON.stringify(now.verified);
      out.push({
        code: verifiedChanged ? "unattested-verification" : "unattested-publish",
        severity: "error",
        path: c.path,
        message: verifiedChanged
          ? "`verified` changed outside the plugin; treat this concept as unverified."
          : `status changed outside the plugin (now ${String(now.status)}).`,
        fix_hint: "A person should review it and use Approve in Obsidian.",
      });
    }
    return out;
  }

  /** Concepts a person should look at, for the Review Queue view (all bundles, no token). */
  reviewQueue(): { bundle: string; concept_id: string; title: string; status: Status | null; zone: string; reasons: string[] }[] {
    const items = [];
    for (const b of this.provider.bundles()) {
      const errors = new Map<string, string[]>();
      for (const d of this.lintAll(b)) {
        if (d.severity === "error" || d.code === "raw-unreferenced") errors.set(d.path, [...(errors.get(d.path) ?? []), d.code]);
      }
      for (const c of b.model.concepts.values()) {
        if (c.status === "deprecated") continue;
        const reasons: string[] = [];
        if (c.status === "draft") reasons.push("draft");
        if (c.frontmatter["review_requested"]) reasons.push("review requested");
        if (verificationOutdated(c.frontmatter)) reasons.push("changed since verified");
        if (isStale(c.frontmatter, this.now())) reasons.push("stale");
        reasons.push(...(errors.get(c.path) ?? []));
        if (reasons.length) items.push({ bundle: b.name, concept_id: c.id, title: c.title, status: c.status, zone: c.zone, reasons });
      }
    }
    return items.sort((a, x) => x.reasons.length - a.reasons.length || a.title.localeCompare(x.title, "en"));
  }

  /**
   * Why the auto approver must leave a concept to a person; empty when it may approve it.
   * A concept a person approved before always goes back to that person: a machine approval
   * would make the old human one look current again (trust tier, verification_outdated).
   */
  approvalBlockers(bundle: string, conceptId: string): string[] {
    const b = this.provider.bundles().find((x) => x.name === bundle);
    const c = b?.model.concepts.get(`${conceptId}.md`);
    if (!b || !c) return ["not found"];
    if (c.zone !== "curated") return ["raw source"];
    if (c.status === "deprecated") return ["deprecated"];
    if (c.status !== "draft" && trustTier(c.frontmatter) !== "unverified" && !verificationOutdated(c.frontmatter)) return ["nothing to approve"];
    const blockers: string[] = [];
    if (normalizeVerified(c.frontmatter).some((v) => v.by.startsWith("human:"))) blockers.push("approved by a person before");
    if (c.frontmatter["review_requested"]) blockers.push("review requested");
    const sources = normalizeSources(c.frontmatter);
    const cited = extractFootnotes(c.body).references;
    if (sources.length === 0) blockers.push("no sources");
    else if (!sources.some((s) => cited.has(String(s.id)))) blockers.push("no footnote cites a source");
    for (const d of this.lintAll(b)) {
      if (d.path === c.path && (d.severity === "error" || d.severity === "warning" || d.code === "source-uncited")) blockers.push(d.code);
    }
    return blockers;
  }

  lint(p: Principal, args: { bundle?: string; concept_id?: string; min_severity?: Severity; limit?: number; cursor?: string }) {
    const b = this.bundle(p, args.bundle);
    const min = SEVERITY_RANK[args.min_severity ?? "info"];
    let path: string | null = null;
    if (args.concept_id) path = this.concept(p, b, args.concept_id).path;
    const all = this.lintAll(b).filter(
      (d) => SEVERITY_RANK[d.severity] <= min && (path ? d.path === path : this.pathAllowed(p, d.path) || d.path === ".okf.yaml"),
    );
    const pg = page(all, args.limit, args.cursor);
    return {
      bundle: b.name,
      counts: { error: all.filter((d) => d.severity === "error").length, warning: all.filter((d) => d.severity === "warning").length, info: all.filter((d) => d.severity === "info").length },
      diagnostics: pg.items,
      total: pg.total,
      ...(pg.next_cursor ? { next_cursor: pg.next_cursor } : {}),
    };
  }

  history(p: Principal, args: { bundle?: string; concept_id?: string; since?: string; limit?: number; cursor?: string }) {
    const b = this.bundle(p, args.bundle);
    const log = b.model.reserved.get("log.md");
    // log.md lists days newest first but appends within a day; the tool promises newest first.
    let entries = (log ? parseLog(log) : [])
      .map((e, i) => ({ e, i }))
      .sort((a, x) => x.e.date.localeCompare(a.e.date) || x.i - a.i)
      .map(({ e }) => e);
    if (args.since) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new ServiceError("invalid-argument", "`since` must be a date like 2026-10-01");
      entries = entries.filter((e) => e.date >= args.since!);
    }
    const linkPath = (link: string) => joinPath("", link.replace(/^\/+/, "").replace(/#.*$/, ""));
    if (args.concept_id) {
      // No existence check: a rejected draft is gone, and its log entries say why (DESIGN.md §5.3).
      const path = conceptPathFromInput(args.concept_id);
      if (!this.pathAllowed(p, path)) throw new ServiceError("not-found", `Concept '${args.concept_id}' not found in bundle '${b.name}'.`);
      entries = entries.filter((e) => (e.link ? linkPath(e.link) === path : e.text.includes(`(${path})`) || e.text.includes(`(/${path})`)));
    } else if (p.pathPrefixes.length > 0) {
      entries = entries.filter((e) => {
        const target = e.link ? linkPath(e.link) : null;
        return target !== null && this.pathAllowed(p, target);
      });
    }
    const pg = page(entries, args.limit, args.cursor);
    return { bundle: b.name, entries: pg.items, total: pg.total, ...(pg.next_cursor ? { next_cursor: pg.next_cursor } : {}) };
  }

  /** The bundle's root index as markdown: the stored index.md, else a live listing. */
  indexMarkdown(p: Principal, bundle: string): string {
    const b = this.bundle(p, bundle);
    // The stored index lists every concept, so a path-scoped token gets a filtered listing.
    const stored = b.model.reserved.get("index.md");
    if (stored !== undefined && p.pathPrefixes.length === 0) return stored;
    const browse = this.browse(p, { bundle: b.name });
    const lines = [`# ${b.name}`, ""];
    for (const d of browse.subdirectories) lines.push(`* [${d.dir}](${d.dir}/index.md)${d.description ? ` - ${d.description}` : ` - ${d.concepts} concepts`}`);
    for (const c of browse.concepts) lines.push(`* [${c.title}](${c.concept_id}.md)${c.description ? ` - ${c.description}` : ""}`);
    return `${lines.join("\n")}\n`;
  }

  /** Raw text of a concept file, for resource reads. */
  conceptText(p: Principal, bundle: string, conceptId: string): { path: string; text: string } {
    const b = this.bundle(p, bundle);
    const c = this.concept(p, b, conceptId);
    return { path: c.path, text: b.model.files.get(c.path) ?? "" };
  }
}
