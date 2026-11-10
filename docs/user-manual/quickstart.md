# Quickstart

Get Claude Code reading a folder of your vault through OKF Wiki in about ten minutes. You need
OKF Wiki installed and enabled; see [Installation](installation.md). Other MCP clients work the same
way; see [Connect an agent](how-to/connect-an-agent.md).

1. Create a folder in your vault for the knowledge agents may use, for example `Knowledge`, and put
   a note or two in it. Notes outside this folder stay private.

2. Open **Settings → OKF Wiki**. Under **Bundles**, type `Knowledge` in **Add a folder** and select
   **Add**.

3. Under **New token**, type `claude-code` in **New token name** and select **Create token**. Leave
   the scopes off: this token can read only.

4. In the dialog that opens, select **Copy** next to **Claude Code, this project folder (run it
   there)**. The token is shown only once. The status bar now shows:

   ```text
   OKF MCP :27150 · 1 bundle
   ```

5. In a terminal, go to the folder where you start Claude Code and paste the command. It looks like
   this, with your own token:

   ```sh
   claude mcp add --transport http --scope local okf-wiki http://127.0.0.1:27150/mcp/ --header "Authorization: Bearer okf_your-token"
   ```

6. Start `claude` and ask:

   ```text
   Which OKF bundles can you use, and what is in them?
   ```

   Claude Code calls `okf_bundles` and describes the `Knowledge` bundle.

You now have an agent that can read and search one folder of your vault, and nothing else.

## Next steps

- [Review and approve agent drafts](how-to/review-and-approve-agent-drafts.md): let the agent write.
- [OKF bundles](concepts/okf-bundles.md): how to organize the folder as it grows.
- [Limit what a token can do](how-to/limit-what-a-token-can-do.md): before you give tokens to more agents.
