// Run by `npm version <x.y.z>`: copies the new version into manifest.json and records the
// minimum Obsidian version for it in versions.json, so the release tag, the manifest and
// package.json always agree.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`Obsidian needs an x.y.z version, got '${version}'`);

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
