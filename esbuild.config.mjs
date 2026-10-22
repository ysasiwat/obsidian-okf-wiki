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
  banner: { js: "/* okf-wiki: bundled by esbuild. Source: https://github.com/ysasiwat/obsidian-okf-wiki */" },
};

if (prod) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
