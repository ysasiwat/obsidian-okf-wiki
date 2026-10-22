import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "okf-bundles");
export const BUNDLE_NAMES = ["acme_retail", "crypto_bitcoin", "ga4", "stackoverflow"] as const;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

/** Fixture-relative POSIX paths of every .md file. */
export function listFixtureConcepts(): string[] {
  const out: string[] = [];
  walk(FIXTURE_ROOT, out);
  return out
    .filter((p) => p.endsWith(".md"))
    .map((p) => relative(FIXTURE_ROOT, p).split(sep).join("/"))
    .sort();
}

export function fixturePath(rel: string): string {
  return join(FIXTURE_ROOT, ...rel.split("/"));
}

const bundleCache = new Map<string, Map<string, string>>();

/** All files of one fixture bundle as bundle-relative POSIX path -> text. Read once; each call gets its own copy. */
export function loadFixtureBundle(name: string): Map<string, string> {
  let cached = bundleCache.get(name);
  if (!cached) {
    const root = join(FIXTURE_ROOT, name);
    const files: string[] = [];
    walk(root, files);
    cached = new Map();
    for (const f of files) {
      cached.set(relative(root, f).split(sep).join("/"), readFileSync(f, "utf8"));
    }
    bundleCache.set(name, cached);
  }
  return new Map(cached);
}
