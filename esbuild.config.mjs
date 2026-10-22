// Bundles the Obsidian plugin to main.js. `node esbuild.config.mjs production` for a
// release build, without arguments for a watching development build.
import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
  outfile: "main.js",
  // The MCP SDK's Node shim pulls in Ajv, which compiles schemas with new Function; its only use
  // is validating elicitation results and fromJsonSchema, neither of which the plugin calls. The
  // browser shim swaps in the code-generation-free @cfworker/json-schema validator (its stub
  // `process` only matters to stdio, which the plugin does not use).
  // shortcut: points at a file inside the SDK's dist/, so an SDK upgrade that renames it fails the build; update the path then.
  alias: { "@modelcontextprotocol/server/_shims": "./node_modules/@modelcontextprotocol/server/dist/shimsBrowser.mjs" },
  banner: { js: "/* okf-wiki: bundled by esbuild. Source: https://github.com/ysasiwat/obsidian-okf-wiki */" },
};

if (prod) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
