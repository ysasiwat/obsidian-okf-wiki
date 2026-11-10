# Undo an agent change

Use this when an agent wrote something you want gone, or when agents are writing and you want them
to stop. OKF Wiki keeps a snapshot of every agent write for 7 days.

## Steps

1. Optional: stop all agent writes first. Run **Pause or resume agent writes**, or turn on
   **Pause agent writes** under **Settings → OKF Wiki → Agent writes**. Reads keep working, and the
   status bar shows `OKF MCP :27150 · writes paused`.
2. Run the command **Revert an agent change…**, or select **Revert a change…** under
   **Agent writes** in the settings.
3. Pick the change from the list. Each line shows the note, the tool, the time, the token and the
   agent's reason.
4. Read the confirmation, which lists the files that will be restored, and select **Revert**.
5. Check that it worked: a notice says `OKF Wiki: reverted N file(s).`
6. If you paused writes in step 1, run **Pause or resume agent writes** again to resume them.

A revert is refused if one of its files changed after the agent's write. Revert the later changes
first, or restore the file by hand.

## See also

- [Review and approve agent drafts](review-and-approve-agent-drafts.md): reject a draft with a reason
  the agent can read.
- [Troubleshooting](../troubleshooting.md#no-snapshot-for-commit--snapshots-are-kept-for-7-days).
