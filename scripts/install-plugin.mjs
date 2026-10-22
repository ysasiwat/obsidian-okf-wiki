// Copy the built plugin into a vault for manual testing:
//   npm run build && node scripts/install-plugin.mjs <path-to-vault>
// Copies main.js, manifest.json and styles.css into <vault>/.obsidian/plugins/<id>/.
// It never edits Obsidian's settings; enable the plugin in Settings > Community plugins.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const vault = process.argv[2];
if (!vault) {
  console.error("usage: node scripts/install-plugin.mjs <path-to-vault>");
  process.exit(2);
}
const root = resolve(vault);
const configDir = join(root, ".obsidian");
if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
  console.error(`not an Obsidian vault (no .obsidian folder): ${root}`);
  process.exit(2);
}
for (const f of ["main.js", "manifest.json"]) {
  if (!existsSync(f)) {
    console.error(`${f} is missing; run npm run build first`);
    process.exit(2);
  }
}
const { id, version } = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = join(configDir, "plugins", id);
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  if (existsSync(f)) copyFileSync(f, join(target, f));
}
console.log(`installed ${id} ${version} into ${target}`);
console.log("Enable it in Obsidian: Settings > Community plugins (reload Obsidian if it was already enabled).");
