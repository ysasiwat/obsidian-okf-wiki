# Review and approve agent drafts

Use this when an agent with the Write scope has written notes and you want to accept or turn them
down. Everything an agent creates starts as a draft until you approve it.

## Before you start

- **Your ID** is set under **Settings → OKF Wiki → Agent writes**, for example your name. Approving
  needs it.

## Steps

1. Open the review queue: run the command **Open review queue**, select the ribbon icon (a
   checklist), or select `OKF review: N` in the status bar.
2. Read each note: select its title to open it. The line under the title gives the reasons it is
   listed, such as `draft`, `review requested`, `changed since verified` or `stale`.
3. To accept one note, select **Approve** next to it. To accept the note you have open, run
   **Approve this note**.
4. Optional: to accept several notes at once, tick them, or select **Select all without errors**,
   then select **Approve selected**.
5. To turn a change down, select **Reject** next to the note, or run **Reject the agent's latest
   change to this note…** while it is open.
6. Type a reason the agent can act on and select **Reject**. A new draft goes to the trash; an edit
   is rolled back. Your reason is written to the bundle's `log.md`, where agents read it.
7. Check that it worked: the note leaves the queue, and a notice confirms, for example
   `OKF Wiki: rejected; restored 1 file(s).`

## See also

- [Trust and provenance](../concepts/trust-and-provenance.md): what approving records.
- [Turn on auto approve](turn-on-auto-approve.md): skip the queue for trusted tokens.
- [Undo an agent change](undo-an-agent-change.md): roll back any recent agent write.
