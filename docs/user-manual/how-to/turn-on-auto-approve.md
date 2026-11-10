# Turn on auto approve

Use this when you trust a token enough that its well-sourced notes should become stable without
waiting in the review queue. Auto approve is off by default.

## Steps

1. Open **Settings → OKF Wiki** and go to **Auto approve**.
2. In **Tokens**, list the token names whose writes may be approved, separated by commas, for
   example `claude-code`. The names must match tokens under **Access tokens**.
3. Optional: in **Bundles**, list the bundle folders where it applies. Empty means every bundle.
4. Turn on **Approve clean agent writes**.
5. Check that it worked: after the agent next writes a note that cites its sources in footnotes,
   the note does not appear in the review queue, and its badge in the status bar shows
   `machine-confirmed`.

## See also

- [Trust and provenance](../concepts/trust-and-provenance.md#auto-approve): which notes auto approve
  accepts, and what it records.
- [Review and approve agent drafts](review-and-approve-agent-drafts.md).
