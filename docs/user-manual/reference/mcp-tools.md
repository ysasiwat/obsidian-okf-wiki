# MCP tools

Applies to OKF Wiki 0.7.0. These are the tools, resources and prompts an agent gets from the server
at `http://127.0.0.1:27150/mcp/` (the port is a setting). An agent sees only the tools its token's
scopes allow, and only the bundles and paths the token is limited to. Each tool also describes its
arguments to the agent; this page is the overview.

## Read tools

Every token has the read scope.

| Tool | Use it to |
| ---- | --------- |
| `okf_bundles` | List the bundles the token can read, with concept counts and lint totals. Agents start here. |
| `okf_browse` | List one folder of a bundle: subfolders, concepts and other files. |
| `okf_read` | Read a concept. Views: `full` (default), `outline`, `frontmatter`, `section`. Returns an `etag` needed to update it. |
| `okf_read_file` | Read a text file that is not a concept, such as an attester's code. |
| `okf_search` | Full-text search, or a filtered listing without `query`. Filters: `bundle`, `type`, `tags`, `status`, `min_trust`, `stale`, `under`, `include_raw`, `unprocessed_raw`, `language`. |
| `okf_graph` | List concepts linked to and from a concept, up to depth 2. |
| `okf_lint` | Run lint on a bundle or one concept; see [Lint codes](lint-codes.md). |
| `okf_history` | Read `log.md` entries, newest first, by concept or since a date. |

## Write tools

Need **Scope: Write**. Writes are refused while agent writes are paused, while you are typing in the
note, or above the rate limits in **Agent writes**.

| Tool | Use it to |
| ---- | --------- |
| `okf_create` | Create a curated concept. It starts as `draft`. |
| `okf_update` | Change a concept. Needs the `etag` from `okf_read` (`if_match`) and a `reason`. Refuses to drop sources, cited footnotes or half the body unless `allow_shrink`. |
| `okf_move` | Move or rename a concept and rewrite links to it. |
| `okf_deprecate` | Mark a concept deprecated, optionally naming the one that replaces it. |
| `okf_describe_directory` | Set a folder's one-line description, shown in its parent's `index.md`. |
| `okf_ingest_raw` | Store original material as a write-once raw source in its own language. |
| `okf_request_review` | Put a concept in your review queue with a one-sentence note. |

## Tools for trusted automation

| Tool | Scope | Use it to |
| ---- | ----- | --------- |
| `okf_publish` | Publish | Change a draft to `stable` without a person's review. |

**Scope: Replace raw sources** lets `okf_ingest_raw` overwrite a raw source. **Scope: Edit
computations** lets write tools author or change Attested Computations.

## Resources

| URI | Content |
| --- | ------- |
| `okf://spec` | A summary of OKF v0.2. |
| `okf://status` | Server status as JSON. |
| `okf://bundles/{bundle}/index` | A bundle's root index. |
| `okf://bundles/{bundle}/concepts/{concept_id}` | A concept's source text. |

## Prompts

| Prompt | Argument | Use it to |
| ------ | -------- | --------- |
| `okf_author_concept` | `topic` | Guide the agent in writing or improving one concept. |
| `okf_distill_raw` | `raw_concept_id` | Turn a raw source into cited English concepts. |

## Errors

A failed tool call returns an error code, a message and usually a hint:

| Code | Meaning |
| ---- | ------- |
| `not-found` | The bundle, concept, folder or file does not exist or is outside the token's limits. |
| `forbidden` | The token lacks the scope, or may not write that path. |
| `invalid-argument` | An argument is malformed, for example a concept id. |
| `ambiguous` | Several bundles are available; pass `bundle`. |
| `not-ready` | Obsidian is still indexing the vault; retry in a few seconds. |
| `exists` | The target concept id is taken. |
| `conflict` | The concept changed since it was read; read it again and retry. |
| `policy` | The write breaks the bundle's policy, for example a reason that is not English. |
| `paused` | You paused agent writes. |
| `rate-limited` | Too many writes for this token; the error says when to retry. |
| `being-edited` | You are editing that note in Obsidian; the error says when to retry. |
