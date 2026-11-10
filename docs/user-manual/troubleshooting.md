# Troubleshooting

Find your error message or symptom below. If it is not listed,
[open an issue](https://github.com/ysasiwat/obsidian-okf-wiki/issues) with your Obsidian and OKF Wiki
versions (**Settings → Community plugins**) and the full error.

## The status bar shows `OKF MCP: no tokens`

**Cause:** The server starts only once an access token exists.

**Fix:** Create a token under **Settings → OKF Wiki → New token**. See
[Connect an agent](how-to/connect-an-agent.md).

## `OKF Wiki: Port 27150 is already in use.`

**Cause:** Another program, or OKF Wiki in a second open vault, listens on that port. The status bar
shows `OKF MCP: error`.

**Fix:** Under **Settings → OKF Wiki → MCP server**, set **Port** to a free port, for example
`27151`. Then update the URL in your agent's configuration.

## `OKF Wiki: The server stopped unexpectedly. Run 'Restart MCP server'.`

**Cause:** The server closed while Obsidian kept running.

**Fix:** Run the command **Restart MCP server**.

## The agent cannot connect, or reports `ECONNREFUSED`

**Cause:** Obsidian is closed, the vault with the plugin is not open, the server is off, or the port
in the agent's configuration differs from the plugin's.

**Fix:** Open the vault in Obsidian and check the status bar shows `OKF MCP :<port> · N bundles`.
Check the server answers; this needs no token:

```sh
curl http://127.0.0.1:27150/health
```

```text
{"ok":true}
```

If the port differs, run **Copy MCP endpoint URL** and put that URL in the agent's configuration.

## `Authorization: Bearer <token> required. Create a token in the plugin settings.`

**Cause:** The request carried no token.

**Fix:** Add the `Authorization: Bearer okf_…` header to the client's configuration, as in the
commands the token dialog shows.

## `invalid token`

**Cause:** The token was revoked, mistyped, or belongs to another vault.

**Fix:** Create a new token and update the agent's configuration. Tokens cannot be shown again.

## `too many failed authentication attempts`

**Cause:** Several requests with a wrong token came from your computer in a short time.

**Fix:** Wait for the time in the `Retry-After` header, then retry with a valid token.

## `The vault owner has paused agent writes.`

**Cause:** Agent writes are paused. The status bar shows `writes paused`.

**Fix:** Run **Pause or resume agent writes**.

## `A person is editing '<concept>' in Obsidian right now.`

**Cause:** You are typing in that note. Agents may not write a note while you edit it.

**Fix:** Stop typing or leave the note. The agent can retry after the time the error names.

## `More than 30 writes in a minute.` or `More than 500 writes today.`

**Cause:** The token hit a rate limit in **Agent writes**.

**Fix:** Wait for the time in the error, or raise **Writes per minute** or **Writes per day**.

## `This token cannot write.`

**Cause:** The token has only the read scope.

**Fix:** Create a token with **Scope: Write**. Scopes cannot be added to an existing token.

## `OKF Wiki: set your ID in the plugin settings first.`

**Cause:** Approving or rejecting needs your ID.

**Fix:** Fill in **Your ID** under **Settings → OKF Wiki → Agent writes**.

## `No snapshot for commit … (snapshots are kept for 7 days)`

**Cause:** The agent change is older than 7 days, so its snapshot is gone.

**Fix:** Edit or restore the note by hand.

## `These files changed after the commit: …`

**Cause:** A later change touched the same files, so a revert would lose it.

**Fix:** Revert the later changes first, or restore by hand.

## A note's badge shows `changed outside the plugin`

**Cause:** Its `status` or `verified` was changed outside OKF Wiki, for example on another device
or by a script.

**Fix:** Read the note. If it is right, approve it again with **Approve this note**.

## `[policy-invalid] auto_log must be true or false`

**Cause:** A key in `.okf.yaml` has a wrong value. Here, `auto_log: yes` is the string `yes`
in YAML 1.2, not a boolean.

**Fix:** Write `true` or `false`. See [Configuration](reference/configuration.md#bundle-policy-okfyaml).

## `not a directory: <path>`

**Cause:** The path given to `okf` does not exist or is a file. `okf` exits with 2.

**Fix:** Pass the bundle's root folder, the one with the root `index.md`.

## `invalid --min-severity: <value>`

**Cause:** `--min-severity` takes only `error`, `warning` or `info`.

**Fix:** Use one of those values.
