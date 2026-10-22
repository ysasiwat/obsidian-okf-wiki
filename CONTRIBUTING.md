# Contributing

Thanks for helping improve OKF Wiki.

## How to contribute

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/AmazingFeature`
3. Make your change, then run `npm run typecheck`, `npm run lint` and `npm test`
4. Commit your changes: `git commit -m 'Add some AmazingFeature'`
5. Push to the branch: `git push origin feature/AmazingFeature`
6. Open a pull request

## Layout

| Path | What |
|---|---|
| `src/core/` | okf-core: parsing, frontmatter splicing, links, trust, language policy, index/log rendering, lint. Pure TypeScript. |
| `src/service/` | bundle service: write pipeline, snapshots, audit, review queue |
| `src/mcp/` | MCP tools, resources and prompts |
| `src/server/` | loopback HTTP server and access tokens |
| `src/obsidian/` | settings, review queue, modals and vault adapters |
| `src/cli/okf.ts` | `okf lint` / `okf index` CLI over okf-core |
| `test/` | vitest suites; `test/fixtures/okf-bundles/` holds byte-exact copies of the OKF sample bundles |

Code comments refer to design notes (DESIGN.md, ADRs) that are kept in the maintainer's development
repository and not published here. To change behaviour, open an issue first so the design can be
discussed.

## Guidelines

- **okf-core stays pure.** Nothing in `src/core/` may import `obsidian` or Node built-ins. A test
  enforces this.
- **Never edit `test/fixtures/okf-bundles/`.** Golden tests compare against those bytes.
- **Preserve bytes you did not change.** Frontmatter edits go through `updateFrontmatterText` /
  `editConcept`; never re-serialize a whole frontmatter block.
- **Lint codes are a contract.** Adding or renaming a code needs a case in
  `test/core/lint-rules.test.ts`.
- **No `node:async_hooks` in plugin code**: it crashed Obsidian's renderer after plugin reloads.
  ESLint enforces this.
- Use `zod` 4. Code, comments and stored knowledge are English.
- One logical change per pull request, with a commit message that says what changed and why.

## Reporting issues

Use the bug report or feature request templates in
[`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Include a clear title, steps to reproduce,
and your Obsidian and plugin versions.
