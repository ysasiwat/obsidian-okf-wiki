// Bundle-relative POSIX path arithmetic and resolution of path-valued fields.
//
// All paths here are bundle-relative without a leading slash ("tables/orders.md"),
// except where a function says it takes or returns a bundle-absolute "/..." form.
// Resolution never escapes the bundle: a path that climbs above the root is outside.

/** Normalize "a/./b/../c" -> "a/c". Returns null if the path climbs above the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, rel: string): string | null {
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

/** Relative path from the directory of `fromFile` to `toFile`. */
export function relativePath(fromFile: string, toFile: string): string {
  const from = dirname(fromFile).split("/").filter(Boolean);
  const to = toFile.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const up = from.length - common;
  const rest = to.slice(common).join("/");
  return up === 0 ? rest : `${"../".repeat(up)}${rest}`;
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function isUrl(value: string): boolean {
  return URL_SCHEME.test(value);
}

/** Decode a markdown link target: strip <...>, drop #fragment/?query, percent-decode. */
export function decodeLinkTarget(raw: string): { path: string; fragment: string } {
  let t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
  const hash = t.indexOf("#");
  const fragment = hash === -1 ? "" : t.slice(hash);
  if (hash !== -1) t = t.slice(0, hash);
  const q = t.indexOf("?");
  if (q !== -1) t = t.slice(0, q);
  try {
    t = decodeURI(t);
  } catch {
    // Leave malformed escapes as written.
  }
  return { path: t, fragment };
}

/** Encode a path for use as a markdown link target. */
export function encodeLinkTarget(path: string): string {
  return path.replace(/[ ()<>%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export type PathResolution =
  | { kind: "url"; value: string }
  | { kind: "descriptor"; value: string }
  | { kind: "outside"; value: string }
  | { kind: "path"; value: string; resolved: string; exists: boolean; ambiguous?: string };

/**
 * Resolve a markdown link target found in the body of `docPath`. Body links are
 * document-relative; a leading "/" means the bundle root (OKF §6.1).
 */
export function resolveBodyLink(docPath: string, target: string): PathResolution {
  if (isUrl(target)) return { kind: "url", value: target };
  const { path } = decodeLinkTarget(target);
  if (path === "") return { kind: "path", value: target, resolved: docPath, exists: true };
  const resolved = path.startsWith("/") ? normalizePath(path) : joinPath(dirname(docPath), path);
  if (resolved === null) return { kind: "outside", value: target };
  return { kind: "path", value: target, resolved, exists: false };
}

/**
 * Resolve a path-valued frontmatter field (`resource`, `sources[].resource`, `computation`,
 * `executor.resource`, `attester.resource`). OKF §6.2 calls a path without "/" relative,
 * but the OKF samples write such paths relative to the bundle root, so both readings are
 * tried (DESIGN.md §4.4). `exists` tells whether a bundle path exists.
 */
export function resolveFieldPath(
  docPath: string,
  value: string,
  exists: (bundlePath: string) => boolean,
): PathResolution {
  const v = value.trim();
  if (isUrl(v)) return { kind: "url", value };
  // A scope descriptor such as "all queries in BigQuery project X" is not a path.
  if (/\s/.test(v) && !v.startsWith("/") && !v.startsWith(".")) return { kind: "descriptor", value };
  if (v.startsWith("/")) {
    const resolved = normalizePath(v);
    if (resolved === null) return { kind: "outside", value };
    return { kind: "path", value, resolved, exists: exists(resolved) };
  }
  const docRelative = joinPath(dirname(docPath), v);
  const bundleRelative = v.startsWith(".") ? null : normalizePath(v);
  const docExists = docRelative !== null && exists(docRelative);
  const bundleExists = bundleRelative !== null && exists(bundleRelative);
  if (docExists && bundleExists && docRelative !== bundleRelative) {
    return { kind: "path", value, resolved: docRelative, exists: true, ambiguous: bundleRelative };
  }
  if (docExists) return { kind: "path", value, resolved: docRelative, exists: true };
  if (bundleExists) return { kind: "path", value, resolved: bundleRelative, exists: true };
  const fallback = docRelative ?? bundleRelative;
  if (fallback === null) return { kind: "outside", value };
  return { kind: "path", value, resolved: fallback, exists: false };
}

/** The canonical form for writing a path-valued field: bundle-absolute. */
export function toBundleAbsolute(bundlePath: string): string {
  return `/${bundlePath}`;
}
