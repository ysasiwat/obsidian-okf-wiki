// Deterministic index.md generation (OKF §8, DESIGN.md §4.5). No LLM: directory
// descriptions come from the existing parent index, else a computed summary.

import { isHiddenPath, type BundleModel, type Concept } from "./bundle";
import { parseConcept } from "./document";
import { renderKey } from "./frontmatter";
import { basename, dirname, encodeLinkTarget } from "./paths";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const SUBDIRECTORIES_HEADING = "Subdirectories";
export const DEPRECATED_HEADING = "Deprecated concepts";
/** Section for non-concept files that have no heading in the existing index. */
export const FILES_HEADING = "Files";

interface Entry {
  title: string;
  link: string;
  description: string;
}

export interface IndexEntryInfo {
  description: string;
  /** The `# heading` the entry was listed under. */
  section: string;
}

const ENTRY = /^[*-] \[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)(?: - (.*))?$/;

/** Entries of an existing index.md, keyed by link target. */
export function parseIndexEntryInfo(text: string): Map<string, IndexEntryInfo> {
  const out = new Map<string, IndexEntryInfo>();
  let section = "";
  for (const l of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^# (.+?)\s*$/.exec(l);
    if (h) {
      section = h[1]!;
      continue;
    }
    const m = ENTRY.exec(l);
    if (m) out.set(m[2]!, { description: (m[3] ?? "").trim(), section });
  }
  return out;
}

/** Map of link target -> description from an existing index.md. */
export function parseIndexEntries(text: string): Map<string, string> {
  return new Map([...parseIndexEntryInfo(text)].map(([k, v]) => [k, v.description]));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function escapeLinkText(s: string): string {
  return s.replace(/([\\[\]])/g, "\\$1");
}

function line(e: Entry): string {
  const desc = oneLine(e.description);
  return `* [${escapeLinkText(oneLine(e.title))}](${e.link})${desc ? ` - ${desc}` : ""}`;
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => collator.compare(a.title, b.title) || (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
}

/** Non-concept files an index lists (code, data, attachments): visible, not markdown. */
function listedFiles(model: BundleModel): string[] {
  return [...model.files.keys()].filter((p) => !isHiddenPath(p) && !p.endsWith(".md"));
}

/** Directories (bundle-relative, "" = root) with at least one concept or file below them. */
export function indexedDirectories(model: BundleModel): string[] {
  const dirs = new Set<string>();
  for (const path of [...model.concepts.keys(), ...listedFiles(model)]) {
    let d = dirname(path);
    for (;;) {
      dirs.add(d);
      if (d === "") break;
      d = dirname(d);
    }
  }
  return [...dirs].sort();
}

function conceptsUnder(model: BundleModel, dir: string): Concept[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  return [...model.concepts.values()].filter((c) => c.path.startsWith(prefix));
}

function summarize(model: BundleModel, dir: string): string {
  const concepts = conceptsUnder(model, dir);
  const prefix = dir === "" ? "" : `${dir}/`;
  const files = listedFiles(model).filter((p) => p.startsWith(prefix)).length;
  const parts: string[] = [];
  if (concepts.length > 0) {
    const types = [...new Set(concepts.map((c) => c.type ?? "untyped"))].sort((a, b) => collator.compare(a, b));
    const shown = types.length > 3 ? `${types.slice(0, 3).join(", ")}, …` : types.join(", ");
    parts.push(`${concepts.length} concept${concepts.length === 1 ? "" : "s"}: ${shown}`);
  }
  if (files > 0) parts.push(`${files} other file${files === 1 ? "" : "s"}`);
  return parts.join("; ");
}

/** Render index.md for `dir`. */
/** `descriptions` overrides subdirectory descriptions, keyed by subdirectory path (okf_describe_directory). */
export function renderDirectoryIndex(model: BundleModel, dir: string, descriptions?: ReadonlyMap<string, string>): string {
  const prefix = dir === "" ? "" : `${dir}/`;
  const indexPath = `${prefix}index.md`;
  const allDirs = indexedDirectories(model);

  // Subdirectory descriptions live in this directory's existing index, keyed by link.
  const existing = model.reserved.get(indexPath);
  const previousInfo = existing ? parseIndexEntryInfo(existing) : new Map<string, IndexEntryInfo>();
  const previous = new Map([...previousInfo].map(([k, v]) => [k, v.description]));

  const subdirs: Entry[] = allDirs
    .filter((d) => d !== dir && dirname(d) === dir)
    .map((d) => {
      const link = `${encodeLinkTarget(basename(d))}/index.md`;
      return { title: basename(d), link, description: descriptions?.get(d) || previous.get(link) || summarize(model, d) };
    });

  const byType = new Map<string, Entry[]>();
  const deprecated: Entry[] = [];
  for (const c of model.concepts.values()) {
    if (dirname(c.path) !== dir) continue;
    const entry: Entry = {
      title: c.status === "draft" ? `${c.title} (draft)` : c.title,
      link: encodeLinkTarget(basename(c.path)),
      description: c.description ?? "",
    };
    if (c.status === "deprecated") {
      deprecated.push(entry);
      continue;
    }
    const type = c.type ?? "Untyped";
    byType.set(type, [...(byType.get(type) ?? []), entry]);
  }

  // Non-concept files keep the heading and description a person gave them.
  for (const f of listedFiles(model)) {
    if (dirname(f) !== dir) continue;
    const link = encodeLinkTarget(basename(f));
    const info = previousInfo.get(link);
    const kept = info?.section;
    const heading = kept && kept !== SUBDIRECTORIES_HEADING && kept !== DEPRECATED_HEADING ? kept : FILES_HEADING;
    byType.set(heading, [...(byType.get(heading) ?? []), { title: basename(f), link, description: info?.description ?? "" }]);
  }

  const sections: string[] = [];
  const section = (heading: string, entries: Entry[]) => {
    if (entries.length > 0) sections.push([`# ${heading}`, "", ...sortEntries(entries).map(line)].join("\n"));
  };
  section(SUBDIRECTORIES_HEADING, subdirs);
  for (const type of [...byType.keys()].sort((a, b) => collator.compare(a, b))) section(type, byType.get(type)!);
  section(DEPRECATED_HEADING, deprecated);

  let header = "";
  if (dir === "") {
    // Keep an okf_version declaration; add one for bundles that carry a policy file.
    let version: string | number | undefined;
    if (existing) {
      try {
        const v = parseConcept(existing).frontmatter["okf_version"];
        // Only a scalar can be written back as okf_version.
        if (typeof v === "string" || typeof v === "number") version = v;
      } catch {
        version = undefined;
      }
    }
    if (version === undefined && model.hasPolicyFile) version = model.policy.okf_version;
    if (version !== undefined) header = `---\n${renderKey("okf_version", String(version))}---\n\n`;
  }
  return `${header}${sections.join("\n\n")}\n`;
}

/** index.md text for every directory that should have one, or only those in `only`. */
export function renderAllIndexes(model: BundleModel, descriptions?: ReadonlyMap<string, string>, only?: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of indexedDirectories(model)) {
    if (only && !only.has(dir)) continue;
    out.set(dir === "" ? "index.md" : `${dir}/index.md`, renderDirectoryIndex(model, dir, descriptions));
  }
  return out;
}
