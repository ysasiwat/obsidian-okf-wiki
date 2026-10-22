// `okf`: lint OKF bundles and maintain their index.md files from the command line or CI,
// using the same okf-core the Obsidian plugin uses.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { analyzeBundle } from "../core/bundle";
import { detectEol } from "../core/document";
import { renderAllIndexes } from "../core/indexRender";
import { countBySeverity, lintBundle, type Diagnostic, type Severity } from "../core/lint";
import { POLICY_FILENAME } from "../core/policy";

const USAGE = `Usage:
  okf lint <bundle-dir> [--json] [--strict] [--min-severity error|warning|info]
      Check OKF v0.2 conformance and the bundle's policy. Exits 1 on errors
      (or on warnings with --strict).
  okf index <bundle-dir> [--check | --write]
      Regenerate index.md files. --check (default) exits 1 if any would change.
`;

/** Load a bundle directory: text for .md and the policy file, names for everything else. */
export function loadBundleDir(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!name.startsWith(".")) walk(full);
      } else if (rel === POLICY_FILENAME || name.endsWith(".md")) {
        files.set(rel, readFileSync(full, "utf8"));
      } else if (!name.startsWith(".")) {
        files.set(rel, "");
      }
    }
  };
  walk(root);
  return files;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function formatDiagnostic(d: Diagnostic): string {
  const hint = d.fix_hint ? `\n      fix: ${d.fix_hint}` : "";
  return `  ${d.severity.padEnd(7)} ${d.path}  [${d.code}] ${d.message}${hint}`;
}

function cmdLint(dir: string, flags: Set<string>, minSeverity: Severity): number {
  const diagnostics = lintBundle(analyzeBundle(loadBundleDir(dir)));
  const shown = diagnostics.filter((d) => RANK[d.severity] <= RANK[minSeverity]);
  const counts = countBySeverity(diagnostics);
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify({ counts, diagnostics: shown }, null, 2)}\n`);
  } else {
    for (const d of shown) process.stdout.write(`${formatDiagnostic(d)}\n`);
    process.stdout.write(`${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info\n`);
  }
  return counts.error > 0 || (flags.has("--strict") && counts.warning > 0) ? 1 : 0;
}

function cmdIndex(dir: string, flags: Set<string>): number {
  const files = loadBundleDir(dir);
  const rendered = renderAllIndexes(analyzeBundle(files));
  const changed: string[] = [];
  for (const [path, text] of rendered) {
    const before = files.get(path);
    const eolText = before !== undefined && detectEol(before) === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
    if (before === eolText) continue;
    changed.push(path);
    if (flags.has("--write")) writeFileSync(join(dir, ...path.split("/")), eolText, "utf8");
  }
  for (const p of changed) process.stdout.write(`${flags.has("--write") ? "wrote" : "would change"} ${p}\n`);
  if (changed.length === 0) process.stdout.write("indexes are up to date\n");
  return !flags.has("--write") && changed.length > 0 ? 1 : 0;
}

export function main(argv: string[]): number {
  const [command, target, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || !target) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const dir = resolve(target);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stderr.write(`not a directory: ${target}\n`);
    return 2;
  }
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const minIdx = rest.indexOf("--min-severity");
  const min = (minIdx >= 0 ? rest[minIdx + 1] : "info") as Severity;
  if (!(min in RANK)) {
    process.stderr.write(`invalid --min-severity: ${String(min)}\n`);
    return 2;
  }
  switch (command) {
    case "lint":
      return cmdLint(dir, flags, min);
    case "index":
      return cmdIndex(dir, flags);
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] && /okf(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
