# Install OKF Wiki

This page installs the OKF Wiki plugin 0.7.0 in Obsidian and, if you want it, the `okf` command line
tool. The plugin takes about two minutes; the `okf` tool about five.

## Requirements

| Requirement | Version | Check with |
| ----------- | ------- | ---------- |
| Obsidian desktop (Windows, macOS or Linux; not mobile) | 1.13.1 or later | **Settings → About** |
| An MCP client that speaks streamable HTTP, such as Claude Code | | `claude --version` |
| Node.js, only for the `okf` tool or a build from source | 22 or later | `node --version` |
| Git, only for the `okf` tool or a build from source | | `git --version` |

## Install the plugin

1. In Obsidian, open **Settings → Community plugins** and turn off restricted mode if it is on.
2. Select **Browse**, search for **OKF Wiki**, then select **Install**.
3. Select **Enable**.
4. Check that it loaded: the status bar shows `OKF MCP: no tokens`. The server starts once you
   create an access token; see the [Quickstart](quickstart.md).

### Install by hand

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/ysasiwat/obsidian-okf-wiki/releases).
2. Put them in `<vault>/.obsidian/plugins/okf-wiki/`.
3. In **Settings → Community plugins**, enable **OKF Wiki**.

### Install from source

```sh
git clone https://github.com/ysasiwat/obsidian-okf-wiki.git
cd obsidian-okf-wiki
npm ci
npm run build
node scripts/install-plugin.mjs <path-to-vault>
```

Then enable **OKF Wiki** under **Settings → Community plugins**.

## Install the `okf` tool

The `okf` tool lints OKF bundles and maintains their `index.md` files outside Obsidian. It is not
published to npm; build it from the repository:

1. Clone the repository and install its dependencies:

   ```sh
   git clone https://github.com/ysasiwat/obsidian-okf-wiki.git
   cd obsidian-okf-wiki
   npm ci
   ```

2. Build the tool:

   ```sh
   npm run build:cli
   ```

   You should see:

   ```text
     dist\okf.cjs  307.4kb

   Done in 889ms
   ```

   The size and time differ a little between versions and machines.

3. Check that it runs:

   ```sh
   node dist/okf.cjs --help
   ```

   You should see:

   ```text
   Usage:
     okf lint <bundle-dir> [--json] [--strict] [--min-severity error|warning|info]
         Check OKF v0.2 conformance and the bundle's policy. Exits 1 on errors
         (or on warnings with --strict).
     okf index <bundle-dir> [--check | --write]
         Regenerate index.md files. --check (default) exits 1 if any would change.
   ```

`okf` has no `--version` option. Its version is the `version` in the repository's `package.json`.

## Upgrade

- Plugin: open **Settings → Community plugins**, select **Check for updates**, then **Update** next
  to OKF Wiki. A manual install is upgraded by replacing the three files.
- `okf` tool: in your clone, run `git pull`, `npm ci` and `npm run build:cli` again.

## Uninstall

In **Settings → Community plugins**, select **Uninstall** next to OKF Wiki.

Obsidian removes the plugin folder, which holds your settings, the token hashes, snapshots and the
audit log. Your notes, including the `index.md` and `log.md` files the plugin wrote, stay in your
vault.

## Next steps

- [Quickstart](quickstart.md): connect your first agent.
- Installation errors: see [Troubleshooting](troubleshooting.md).
