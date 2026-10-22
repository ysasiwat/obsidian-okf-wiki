// An in-memory model of one bundle: its policy, concepts, resolved links and backlinks.
// Built from a plain map of files, so the CLI (disk) and the plugin (vault) share it.

import { conceptIdFromPath, isReservedFilename } from "./conceptId";
import { OkfParseError, parseConcept } from "./document";
import { extractLinks, type BodyLink } from "./links";
import { basename, decodeLinkTarget, dirname, joinPath, resolveBodyLink, resolveFieldPath, type PathResolution } from "./paths";
import { parsePolicy, POLICY_FILENAME, zoneOf, type BundlePolicy, type Zone } from "./policy";
import { normalizeSources } from "./sources";
import { lifecycleStatus, type Status } from "./trust";

/** Bundle-relative POSIX path -> file text. Non-markdown files may map to "". */
export type BundleFiles = ReadonlyMap<string, string>;

export type EdgeKind = "link" | "source" | "resource" | "computation" | "executor" | "attester";

export interface ResolvedLink {
  link: BodyLink;
  resolution: PathResolution;
  /** Bundle path the link points at when it resolves to an existing file. */
  target: string | null;
  /** For a broken link: a file elsewhere in the bundle with the same name, which
   *  Obsidian would resolve to by its filename fallback (ADR 0001, S1). */
  filenameMatch: string | null;
}

export interface FieldPath {
  field: string;
  value: string;
  resolution: PathResolution;
  target: string | null;
}

export interface Concept {
  path: string;
  id: string;
  zone: Zone;
  hasFrontmatter: boolean;
  parseError: { code: OkfParseError["code"]; message: string } | null;
  frontmatter: Record<string, unknown>;
  body: string;
  type: string | null;
  title: string;
  description: string | null;
  status: Status | null;
  links: ResolvedLink[];
  fieldPaths: FieldPath[];
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface BundleModel {
  files: BundleFiles;
  policy: BundlePolicy;
  policyProblems: string[];
  hasPolicyFile: boolean;
  concepts: Map<string, Concept>;
  /** Reserved files (index.md / log.md) by path. */
  reserved: Map<string, string>;
  edges: Edge[];
  backlinks: Map<string, Edge[]>;
}

/** Files under a dot-directory (.obsidian, .trash, .git) or dot-files are not bundle content. */
export function isHiddenPath(path: string): boolean {
  // Same as "some segment starts with a dot", without splitting.
  return path.startsWith(".") || path.includes("/.");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function collectFieldPaths(fm: Record<string, unknown>): { field: string; value: string; kind: EdgeKind }[] {
  const out: { field: string; value: string; kind: EdgeKind }[] = [];
  const res = str(fm["resource"]);
  if (res) out.push({ field: "resource", value: res, kind: "resource" });
  normalizeSources(fm).forEach((s, i) => {
    if (typeof s.resource === "string" && s.resource.trim()) {
      out.push({ field: `sources[${i}].resource`, value: s.resource, kind: "source" });
    }
  });
  const comp = str(fm["computation"]);
  if (comp) out.push({ field: "computation", value: comp, kind: "computation" });
  for (const key of ["executor", "attester"] as const) {
    const v = fm[key];
    const r = v && typeof v === "object" ? str((v as { resource?: unknown }).resource) : null;
    if (r) out.push({ field: `${key}.resource`, value: r, kind: key });
  }
  return out;
}

/** What resolving a concept needs to know about the rest of its bundle. */
export interface BundleResolver {
  policy: BundlePolicy;
  // Properties, not methods: they are passed around as callbacks.
  exists: (path: string) => boolean;
  /** Visible files with this lowercase basename, for Obsidian's filename fallback. */
  sameName: (name: string) => string[];
}

export function bundleResolver(files: BundleFiles, policy: BundlePolicy): BundleResolver {
  const visible = new Set([...files.keys()].filter((p) => !isHiddenPath(p)));
  let byBasename: Map<string, string[]> | null = null;
  return {
    policy,
    exists: (p) => visible.has(p),
    sameName: (name) => {
      // Built on first use: only broken links need it.
      if (!byBasename) {
        byBasename = new Map();
        for (const p of visible) {
          const b = basename(p).toLowerCase();
          byBasename.set(b, [...(byBasename.get(b) ?? []), p]);
        }
      }
      return byBasename.get(name) ?? [];
    },
  };
}

/**
 * One concept resolved against its bundle: the per-file part of analyzeBundle. `earlier` is the
 * same file's concept from a previous model, given only when the text is unchanged; its parse,
 * extracted links and markdown link targets are reused, and existence is rechecked.
 */
export function analyzeConcept(path: string, text: string, r: BundleResolver, earlier?: Concept): { concept: Concept; edges: Edge[] } {
  const edges: Edge[] = [];
  let frontmatter: Record<string, unknown> = {};
  let body = text;
  let hasFrontmatter = false;
  let parseError: Concept["parseError"] = null;
  let extracted: BodyLink[];
  if (earlier) {
    ({ frontmatter, body, hasFrontmatter, parseError } = earlier);
    extracted = earlier.links.map((l) => l.link);
  } else {
    try {
      const parsed = parseConcept(text);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
      hasFrontmatter = parsed.frontmatterText !== null;
    } catch (e) {
      if (!(e instanceof OkfParseError)) throw e;
      parseError = { code: e.code, message: e.message };
    }
    extracted = extractLinks(body);
  }

  const links: ResolvedLink[] = extracted.map((link, i) => {
    let resolution: PathResolution;
    if (link.kind === "wikilink" || link.kind === "embed") {
      // Wikilinks name a path without the .md suffix, relative to the document or the
      // bundle root. Obsidian's vault-wide filename fallback is reported separately.
      const t = link.target;
      const names = t.endsWith(".md") || /\.[A-Za-z0-9]+$/.test(t) ? [t] : [`${t}.md`, t];
      const candidates = [
        ...names.map((n) => joinPath(dirname(path), n)),
        ...names.map((n) => joinPath("", n)),
      ].filter((c): c is string => c !== null);
      const hit = candidates.find(r.exists);
      resolution = {
        kind: "path", value: t, resolved: hit ?? candidates[0] ?? t, exists: hit !== undefined,
      };
    } else {
      // Where a markdown link points depends only on the text; whether it exists is rechecked.
      const before = earlier?.links[i];
      resolution = before?.link === link ? before.resolution : resolveBodyLink(path, link.target);
      if (resolution.kind === "path") resolution = { ...resolution, exists: r.exists(resolution.resolved) };
    }
    const target = resolution.kind === "path" && resolution.exists ? resolution.resolved : null;
    let filenameMatch: string | null = null;
    if (resolution.kind === "path" && !resolution.exists) {
      const name = basename(decodeLinkTarget(link.target).path || link.target).toLowerCase();
      const matches = r.sameName(name.endsWith(".md") || name.includes(".") ? name : `${name}.md`);
      filenameMatch = matches.length === 1 ? matches[0]! : null;
    }
    if (target && target !== path) edges.push({ from: path, to: target, kind: "link" });
    return { link, resolution, target, filenameMatch };
  });

  const fieldPaths: FieldPath[] = collectFieldPaths(frontmatter).map(({ field, value, kind }) => {
    const resolution = resolveFieldPath(path, value, r.exists);
    const target = resolution.kind === "path" && resolution.exists ? resolution.resolved : null;
    if (target && target !== path) edges.push({ from: path, to: target, kind });
    return { field, value, resolution, target };
  });

  const id = conceptIdFromPath(path);
  const concept: Concept = {
    path,
    id,
    zone: zoneOf(path, r.policy),
    hasFrontmatter,
    parseError,
    frontmatter,
    body,
    type: str(frontmatter["type"]),
    title: str(frontmatter["title"]) ?? basename(id),
    description: str(frontmatter["description"]),
    status: lifecycleStatus(frontmatter),
    links,
    fieldPaths,
  };
  return { concept, edges };
}

/**
 * Model of a bundle. With `previous`, files whose text is unchanged reuse its parse (frontmatter,
 * body, extracted links), the costly part; resolution, zones and backlinks are always recomputed.
 * The result equals a fresh analysis (property test in bundle-incremental.test.ts).
 */
export function analyzeBundle(files: BundleFiles, previous?: BundleModel): BundleModel {
  const steps = analysisSteps(files, previous);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * analyzeBundle that hands control back between files once `sliceMs` has passed, so a large bundle
 * does not block a UI thread (DESIGN.md §13 4A). Same result; `pause` resumes on a later tick.
 */
export async function analyzeBundleSliced(files: BundleFiles, previous: BundleModel | undefined, pause: () => Promise<void>, sliceMs = 16): Promise<BundleModel> {
  const steps = analysisSteps(files, previous);
  let sliceStart = Date.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (Date.now() - sliceStart >= sliceMs) {
      await pause();
      sliceStart = Date.now();
    }
  }
}

/** The analysis, yielding after each concept so a driver can decide when to pause. */
function* analysisSteps(files: BundleFiles, previous?: BundleModel): Generator<void, BundleModel, void> {
  const { policy, problems } = parsePolicy(files.get(POLICY_FILENAME));
  const resolver = bundleResolver(files, policy);
  const concepts = new Map<string, Concept>();
  const reserved = new Map<string, string>();
  const edges: Edge[] = [];

  for (const path of [...files.keys()].filter((p) => !isHiddenPath(p)).sort()) {
    if (!path.endsWith(".md")) continue;
    const text = files.get(path) ?? "";
    if (isReservedFilename(path)) {
      reserved.set(path, text);
      continue;
    }
    const earlier = previous?.files.get(path) === text ? previous.concepts.get(path) : undefined;
    const analyzed = analyzeConcept(path, text, resolver, earlier);
    concepts.set(path, analyzed.concept);
    for (const e of analyzed.edges) edges.push(e);
    yield;
  }

  const backlinks = new Map<string, Edge[]>();
  for (const e of edges) backlinks.set(e.to, [...(backlinks.get(e.to) ?? []), e]);

  return {
    files,
    policy,
    policyProblems: problems,
    hasPolicyFile: files.has(POLICY_FILENAME),
    concepts,
    reserved,
    edges,
    backlinks,
  };
}