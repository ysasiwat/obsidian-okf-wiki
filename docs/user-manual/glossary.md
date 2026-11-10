# Glossary

| Term | Definition |
| ---- | ---------- |
| Actor | Who made a change: `<token>/<version>` for an agent, `process:<name>` for automation, `human:<id>` for you. |
| Attested Computation | An OKF concept type that describes a computation and how to check its result. Changing one needs the Edit computations scope. |
| Auto approve | An optional setting that approves clean writes of chosen tokens as `process:auto-approve`. |
| BCP 47 | The standard for language tags, such as `en` or `th`. |
| Bundle | A folder served as an OKF bundle: concepts plus `index.md`, `log.md` and optionally `.okf.yaml`. |
| Concept | One note in a bundle. Its id is its path in the bundle without `.md`. |
| Curated zone | Every part of a bundle outside the raw folders. Notes there are in the bundle's content language. |
| Draft | A note whose `status` is `draft`: written but not approved. |
| Etag | A fingerprint of a concept's text that `okf_read` returns and `okf_update` needs, so a write never overwrites a change it did not see. |
| Lint | The checks `okf lint` and `okf_lint` run. See [Lint codes](reference/lint-codes.md). |
| MCP | Model Context Protocol, the protocol agents use to call the server's tools. |
| OKF | Open Knowledge Format, the bundle format OKF Wiki follows (v0.2). |
| Raw source | Original material stored write-once in a raw folder, in any language. |
| Review queue | The panel listing notes that need you: drafts, review requests, stale notes and notes changed since verified. |
| Scope | What a token may do beyond reading: Write, Publish, Replace raw sources, Edit computations. |
| Snapshot | The state of the files before an agent write, kept 7 days so you can revert it. |
| Stale | Past the date in a note's `stale_after`. |
| Token | The secret an agent sends to the server. It starts with `okf_`. |
| Trust tier | `unverified`, `machine-confirmed` or `human-reviewed`, from a note's `verified` entries. |
