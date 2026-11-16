# Command line reference

Applies to OKF Wiki 0.7.0. The `okf` tool is built to `dist/okf.cjs`; see
[Installation](../installation.md#install-the-okf-tool). Run it with `node dist/okf.cjs`.

```text
okf COMMAND <bundle-dir> [OPTIONS]
```

`<bundle-dir>` is the bundle's root folder, the one that holds its root `index.md`. `okf` reads
every `.md` file and `.okf.yaml` in it and skips folders whose name starts with `.`.

## Global options

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--help`, `-h` | | Show the usage and exit with 0. Also works after a command, as in `okf lint --help`. |

`okf` has no `--version` option. Run without arguments, or with a command but no `<bundle-dir>`, it
prints the usage and exits with 2.

## `okf lint`

Check a bundle's OKF v0.2 conformance and its `.okf.yaml` policy.

```text
okf lint <bundle-dir> [--json] [--strict] [--min-severity error|warning|info]
```

| Argument or option | Required | Default | Description |
| ------------------ | -------- | ------- | ----------- |
| `<bundle-dir>` | Yes | | The bundle to check. |
| `--json` | No | off | Print `{ "counts": {...}, "diagnostics": [...] }` as JSON instead of text. |
| `--strict` | No | off | Exit with 1 on warnings too, not only on errors. |
| `--min-severity` | No | `info` | Lowest severity to print: `error`, `warning` or `info`. The summary counts and the exit code still include every finding. |

Each finding is printed as severity, path, `[code]`, message and, on the next line, a fix hint. The
last line counts errors, warnings and info. The codes are listed in [Lint codes](lint-codes.md).

Example:

```sh
node dist/okf.cjs lint my-bundle --strict --min-severity warning
```

```text
0 error(s), 0 warning(s), 2 info
```

## `okf index`

Regenerate the `index.md` file of every folder in a bundle, or check whether any is out of date.

```text
okf index <bundle-dir> [--check | --write]
```

| Argument or option | Required | Default | Description |
| ------------------ | -------- | ------- | ----------- |
| `<bundle-dir>` | Yes | | The bundle to index. |
| `--check` | No | on | Print `would change <path>` for each out-of-date index and change nothing. |
| `--write` | No | off | Write the out-of-date indexes and print `wrote <path>` for each. |

When nothing needs to change, it prints `indexes are up to date`. A file that uses CRLF line endings
keeps them.

Example:

```sh
node dist/okf.cjs index my-bundle
```

```text
would change tables/index.md
```

## `okf serve`

Serve a vault's OKF Wiki MCP server while Obsidian is closed, with the plugin's settings and tokens.
It hands the port to the plugin when Obsidian opens the vault and takes it back when Obsidian closes
it. See [Serve agents while Obsidian is closed](../how-to/serve-while-obsidian-is-closed.md).

```text
okf serve --vault <path> [--config-dir <folder>] [--install | --uninstall | --start | --stop | --status]
```

| Argument or option | Required | Default | Description |
| ------------------ | -------- | ------- | ----------- |
| `--vault <path>` | Yes | | The vault folder. |
| `--config-dir <folder>` | No | found | The vault's Obsidian configuration folder. Without it, `okf serve` uses the one dot-folder in the vault that holds `plugins/okf-wiki`, and exits with `2` when there is none or more than one. |
| `--install` | No | off | Windows only: copy this CLI to `%USERPROFILE%\.okf-wiki\` and register a Task Scheduler task that runs `okf serve` at logon with no window, then start it. |
| `--uninstall` | No | off | Windows only: remove that task and stop the running server. |
| `--start` | No | off | Windows only: run the installed task now. Exits with `1` when no task is installed for the vault. |
| `--stop` | No | off | Stop the server running for the vault. An installed task starts it again at the next logon. |

Without `--install` or `--uninstall` it runs in the foreground until stopped and logs to
`<config-dir>/plugins/okf-wiki/state/daemon.log`. It exits with `1` when another `okf serve`
already runs for the vault.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Success: no errors (no warnings with `--strict`), indexes up to date, or `--write` done. |
| `1` | `lint` found errors (or warnings with `--strict`); `index --check` found an out-of-date index. |
| `2` | No command, an unknown command, a missing `<bundle-dir>` or one that is not a folder, or an invalid `--min-severity`. |

## Environment variables

`okf` reads no environment variables.
