// Lint the code that ships in the plugin against Obsidian's guidelines
// (eslint-plugin-obsidianmd, the checks the community directory review runs).
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "dist/**", "coverage/**", "node_modules/**", "test/**", "eval/**", "spikes/**", "scripts/**", "src/cli/**", "*.config.*", "esbuild.config.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          acronyms: ["OKF", "MCP", "ID", "URL", "YAML"],
          brands: ["OKF Wiki", "Claude Code", "Obsidian"],
          // Placeholders that are example values, e.g. a token name.
          ignoreRegex: ["^[a-z0-9._-]+$"],
        },
      ],
      // ADR 0006: AsyncLocalStorage crashed Obsidian's renderer after plugin reloads.
      "no-restricted-imports": ["error", {
        paths: ["node:async_hooks", "async_hooks"].map((name) => ({ name, message: "Crashes Obsidian's renderer after plugin reloads (ADR 0006); pass request context explicitly." })),
      }],
    },
  },
]);
