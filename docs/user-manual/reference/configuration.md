# Configuration reference

Applies to OKF Wiki 0.7.0.

## Where settings come from

OKF Wiki has two kinds of settings:

1. Plugin settings, under **Settings → OKF Wiki**. They belong to this vault on this device and are
   stored in the plugin's `data.json`.
2. Bundle policy, in a `.okf.yaml` file at a bundle's root. It travels with the bundle, so the
   plugin on every device and `okf lint` in CI apply the same rules.

A missing or invalid value uses the default. There are no environment variables.

## Plugin settings

### MCP server

| Setting | Default | Description |
| ------- | ------- | ----------- |
| Enable server | on | Serve the MCP endpoint on `127.0.0.1`. It starts only once a token exists. |
| Port | `27150` | 1024 to 65535. Changing it restarts the server. |

### Bundles

| Setting | Default | Description |
| ------- | ------- | ----------- |
| Served folders | none | Folders served as bundles, each with a toggle and a button to stop serving it. Files are not touched. |
| Add a folder | | A vault-relative folder path, such as `Knowledge`. |
| Found: `<folder>` | | A folder that declares itself an OKF bundle. **Enable** or **Dismiss** it. |

### Agent writes

| Setting | Default | Description |
| ------- | ------- | ----------- |
| Pause agent writes | off | Refuse every agent write. Reads keep working. |
| Writes per minute | `30` | Per token, 1 to 1000. |
| Writes per day | `500` | Per token, 1 to 100000. |
| Your ID | empty | Recorded as `human:<id>` when you approve, revert and edit. Letters, digits and `. _ @ + -`, starting with a letter or digit, up to 64 characters. Approving needs it. |
| Record your edits | on | Record you in a note's `generated` field when you leave it or stop typing for a minute. Needs your ID. |
| Snapshots and audit | | Kept in the plugin folder's `state` subfolder for 7 days. **Revert a change…** opens the revert list. |

If your vault's `.obsidian` folder is in git, add the plugin's `state` folder to `.gitignore`.

### Auto approve

| Setting | Default | Description |
| ------- | ------- | ----------- |
| Approve clean agent writes | off | Approve notes from the listed tokens that cite sources in footnotes, have no lint warnings and no review request, as `process:auto-approve`. |
| Tokens | empty | Token names, separated by commas. |
| Bundles | empty | Bundle folders, separated by commas. Empty means every bundle. |

### Access tokens

Lists each token with its scopes, bundles, paths, creation date and last use, and a **Revoke**
button. Only a SHA-256 hash of each token is stored.

### New token

| Setting | Default | Description |
| ------- | ------- | ----------- |
| New token name | | Lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit, up to 64 characters. |
| Limit to bundles | empty | Bundle folders, separated by commas. Empty means all bundles. |
| Limit to paths | empty | Folders inside the bundles, separated by commas. Empty means everything. |
| Scope: Write | off | Create, update, move and deprecate concepts and ingest raw sources. New concepts are drafts. |
| Scope: Publish | off | Make drafts stable without a person's review. |
| Scope: Replace raw sources | off | Overwrite write-once raw sources. |
| Scope: Edit computations | off | Author or change Attested Computations. |
| Automated process | off | Stamp writes `process:<name>` instead of `<name>/<version>`. |

Every token can read. Tokens start with `okf_`.

### Advanced

| Setting | Default | Description |
| ------- | ------- | ----------- |
| Allowed browser origins | empty | Hostnames whose web pages may call the server. Leave it empty: MCP clients send no origin, and any page that does is refused. |

## Bundle policy (`.okf.yaml`)

Location: `<bundle>/.okf.yaml`. Agents cannot change it; MCP tools write only `.md` files.

Example:

```yaml
okf_version: "0.2"
content_language: en
raw_dirs: [references/raw]
non_english_threshold: 0.05
auto_index: true
auto_log: true
agent_initial_status: draft
```

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `okf_version` | string | `"0.2"` | OKF version of the bundle. |
| `content_language` | string | `en` | Language of curated notes, as a BCP 47 tag. |
| `raw_dirs` | list | `[references/raw]` | Bundle-relative folders whose notes are raw sources in any language. |
| `non_english_threshold` | number, 0 to 1 | `0.05` | Largest share of non-Latin letters in a curated note before it counts as non-English. |
| `auto_index` | boolean | `true` | Keep `index.md` files up to date on every write. `false` means you maintain them. |
| `auto_log` | boolean | `true` | Add an entry to `log.md` on every write. |
| `agent_initial_status` | `draft` or `stable` | `draft` | Status of notes an agent creates. |

Booleans must be `true` or `false`; `yes` and `no` are strings in YAML 1.2. An unknown key or a
wrong value is reported as `policy-invalid` and the default is used.

## Environment variables

None. The plugin and `okf` read no environment variables.
