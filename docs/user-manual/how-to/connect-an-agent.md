# Connect an agent

Use this when you want an MCP client, such as Claude Code, to read or write the folders OKF Wiki
serves.

## Before you start

- At least one folder is served under **Settings → OKF Wiki → Bundles**.
- The agent runs on the same computer as Obsidian. The server listens on `127.0.0.1` only.

## Steps

1. Open **Settings → OKF Wiki** and go to **New token**.
2. Type a name for the agent in **New token name**, for example `claude-code`. Use lowercase
   letters, digits, `.`, `_` or `-`.
3. If the agent may write drafts, turn on **Scope: Write**. Leave it off for read only.
4. Optional: limit the token to some bundles or folders; see
   [Limit what a token can do](limit-what-a-token-can-do.md).
5. Select **Create token**. A dialog shows the token once.
6. Copy the line for your client and close the dialog:
   - **Claude Code, this project folder (run it there)** adds the server with `--scope local`, for
     the folder you run it in.
   - **Claude Code, all your projects** adds it with `--scope user`.
   - **.mcp.json** is a configuration block for other MCP clients:

     ```json
     {
       "mcpServers": {
         "okf-wiki": {
           "type": "http",
           "url": "http://127.0.0.1:27150/mcp/",
           "headers": {
             "Authorization": "Bearer okf_your-token"
           }
         }
       }
     }
     ```

7. Run the Claude Code command in a terminal, or put the `.mcp.json` block in your client's
   configuration.
8. Check that it worked: ask the agent "Which OKF bundles can you use?". It calls `okf_bundles` and
   lists your bundles.

Do not add the server with `--scope project` and do not commit a `.mcp.json` that holds a token:
both put the token in a file that is often committed to git.

If you lose the token, revoke it under **Access tokens** and create another; only a hash is kept.

## See also

- [MCP tools](../reference/mcp-tools.md): what the agent can call.
- [Trust and provenance](../concepts/trust-and-provenance.md): what happens to what the agent writes.
- [Troubleshooting](../troubleshooting.md): `invalid token`, port in use.
