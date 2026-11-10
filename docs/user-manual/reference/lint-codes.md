# Lint codes

Applies to OKF Wiki 0.7.0. `okf lint`, the `okf_lint` tool and the review queue report the same
codes. Errors make `okf lint` exit with 1, and **Select all without errors** in the review queue
skips notes that have one.

## Bundle files

| Code | Severity | Reported when |
| ---- | -------- | ------------- |
| `policy-invalid` | warning | `.okf.yaml` is not valid YAML, is not a mapping, has an unknown key, or a key has a wrong value. The default is used instead. |
| `log-format` | warning | `log.md` does not follow the log format. |
| `index-format` | warning | An `index.md` has frontmatter. Only the root `index.md` may carry `okf_version`. |

## Frontmatter

| Code | Severity | Reported when |
| ---- | -------- | ------------- |
| `invalid-frontmatter` | error | The YAML between the `---` lines does not parse. |
| `missing-frontmatter` | error | The note has no frontmatter. |
| `missing-type` | error | `type` is missing or empty. |
| `nonportable-id` | info | The file name is not a lowercase ASCII name such as `my-note.md`. |
| `description-multiline` | warning | `description` spans several lines. |
| `description-too-long` | warning | `description` is longer than 200 characters. |
| `tag-format` | warning | `tags` is one string instead of a YAML list. |
| `tag-invalid` | warning | A tag is not a lowercase ASCII word without spaces, or is all digits. |
| `status-invalid` | warning | `status` is not `draft`, `stable` or `deprecated`. |
| `timestamp-invalid` | warning | `stale_after`, `generated.at` or `verified[].at` is not an ISO 8601 datetime with a UTC offset, such as `2026-12-31T00:00:00Z`. |
| `stale` | info | The note is past its `stale_after`. |
| `generated-invalid` | warning | `generated` is not a mapping with `by`. |
| `actor-invalid` | warning | `generated.by` or `verified[].by` is not a valid actor. |
| `computation-missing-runtime` | warning | A note of type `Attested Computation` has no `runtime`. |

## Sources and citations

| Code | Severity | Reported when |
| ---- | -------- | ------------- |
| `source-missing-resource` | warning | A `sources` entry has no `resource`. |
| `source-duplicate-id` | warning | Two `sources` entries share an `id`. |
| `footnote-dangling` | warning | A footnote is referenced but not defined. |
| `source-uncited` | info | A `sources` entry is never cited in a footnote, while other footnotes are. |
| `table-uncited` | warning | A table has no footnote, although the note cites a raw source. |

## Links and paths

| Code | Severity | Reported when |
| ---- | -------- | ------------- |
| `wikilink` | warning | The body uses a `[[wikilink]]` or embed instead of a markdown link. Run **Convert links in this bundle to OKF form**. |
| `link-outside-bundle` | warning | A link points outside the bundle. |
| `broken-link` | info | A link does not resolve inside the bundle. |
| `absolute-link` | warning | A markdown link starts with `/`; Obsidian resolves it against the vault root. Use a relative path. |
| `path-ambiguous` | warning | A path field resolves both relative to the note and relative to the bundle. |
| `path-broken` | info | A path field does not resolve inside the bundle. |
| `path-outside-bundle` | warning | A path field points outside the bundle. |

## Language and raw sources

| Code | Severity | Reported when |
| ---- | -------- | ------------- |
| `language-not-english` | error | `title`, `description` or `tags` is not English, or a curated body has more non-Latin letters than `non_english_threshold`. |
| `raw-type` | error | A note in a raw folder does not have `type: Raw Source`. |
| `raw-language` | error | A raw source has no `language` BCP 47 tag, such as `th`. |
| `raw-resource` | error | A raw source has no `resource`. |
| `raw-hash-missing` | warning | A raw source has no `content_sha256`, so edits cannot be detected. |
| `raw-modified` | error | A raw source's body no longer matches its `content_sha256`. |
| `raw-unreferenced` | info | No curated note cites the raw source yet. |

See [Language policy and raw sources](../concepts/language-policy-and-raw-sources.md).
