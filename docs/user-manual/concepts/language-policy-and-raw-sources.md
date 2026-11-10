# Language policy and raw sources

A bundle keeps curated notes in one language, English by default, and stores original material in
any language as raw sources. Agents and people then share one language for curated knowledge, while
the original wording stays available to check against.

## How it works

A bundle has two zones, decided by path:

| Zone | Where | Language | Changes |
| ---- | ----- | -------- | ------- |
| Curated | Everywhere except the raw folders | The bundle's `content_language` (default `en`) | Agents edit; you approve |
| Raw | `references/raw/` by default (`raw_dirs` in `.okf.yaml`) | Any | Write-once |

```mermaid
flowchart LR
  O[Original report, any language] -->|okf_ingest_raw| R[Raw source in references/raw/]
  R -->|cited in sources and footnotes| C[English curated note]
```

An agent stores original material with `okf_ingest_raw`. The raw source gets `type: Raw Source`,
its `language` as a BCP 47 tag such as `th`, the `resource` it came from, and a `content_sha256` of
its body. The agent then writes English notes that list the raw source in `sources` and cite it in a
footnote on every paragraph, list item and table taken from it.

Titles, descriptions and tags are English in both zones; the original title goes in
`original_title`.

## How the policy is checked

- A curated note whose body has more than 5% non-Latin letters counts as non-English
  (`non_english_threshold` in `.okf.yaml`) and fails lint with `language-not-english`.
- A raw source whose body no longer matches its `content_sha256` fails lint with `raw-modified`.
  If you changed it on purpose, run **Accept edits to this raw source**.
- A raw source no curated note cites yet is reported as `raw-unreferenced`, the queue of material
  still to distill.

## Limits

- The language check counts letters by script, so it tells Latin from non-Latin text, not English
  from French.
- Overwriting a raw source needs the **Replace raw sources** scope.

## Related

- [Configuration](../reference/configuration.md#bundle-policy-okfyaml)
- [Lint codes](../reference/lint-codes.md)
- [MCP tools](../reference/mcp-tools.md)
