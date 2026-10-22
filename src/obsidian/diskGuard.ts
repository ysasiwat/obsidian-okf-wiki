// Where a vault path lands on disk. Obsidian follows symlinks and junctions, so a link
// inside a bundle could expose files outside the vault or the configuration directory,
// which holds plugin code and this plugin's settings. Every file is checked by its real
// path before it is served. The rule follows obsidian-local-rest-api src/vaultPath.ts; no code
// is taken from it.

import { realpathSync } from "node:fs";
import { join, sep } from "node:path";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function norm(p: string): string {
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** Whether `child` is `parent` or inside it (both real, absolute paths). */
export function isWithin(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * A predicate over vault-relative paths: true only when the file's real location is
 * inside the vault and outside the configuration directory. Errors (missing file,
 * broken link, permission) count as unsafe.
 */
export function createDiskGuard(vaultBasePath: string, configDir: string): (vaultPath: string) => boolean {
  const vaultReal = realpathSync.native(vaultBasePath);
  let configReal: string;
  try {
    configReal = realpathSync.native(join(vaultBasePath, configDir));
  } catch {
    configReal = join(vaultReal, configDir);
  }
  return (vaultPath: string) => {
    try {
      const real = realpathSync.native(join(vaultBasePath, ...vaultPath.split("/")));
      return isWithin(real, vaultReal) && !isWithin(real, configReal);
    } catch {
      return false;
    }
  };
}
