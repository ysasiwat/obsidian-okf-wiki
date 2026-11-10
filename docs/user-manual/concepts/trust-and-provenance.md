# Trust and provenance

Provenance is the record of who wrote a note, from what and why; trust is how far that note has been
checked. OKF Wiki records both for you, so an agent reading a note can tell your reviewed knowledge
from an agent's unchecked draft.

## Status

Every note has a lifecycle `status`:

| Status | Meaning |
| ------ | ------- |
| `draft` | Written but not accepted. Notes agents create start here. |
| `stable` | Accepted. A note without `status` counts as stable. |
| `deprecated` | Kept for history, hidden from search by default. |

## Trust tiers

The trust tier comes from the note's `verified` entries:

| Tier | When |
| ---- | ---- |
| `unverified` | No one has verified the note. |
| `machine-confirmed` | Only agents or processes verified it, including `process:auto-approve`. |
| `human-reviewed` | A person verified it: an entry by `human:<your ID>`. |

Only you, in Obsidian, can make a note human-reviewed. No token can, whatever its scopes. Approving a
draft makes it stable and adds your verification.

## Auto approve

With auto approve on, a note written by a listed token is approved at once when it has sources cited
in footnotes, no lint warnings and no review request. The approval is recorded as
`process:auto-approve`, so the note becomes stable and machine-confirmed, not human-reviewed. Notes
you approved yourself still come back to you after an agent edits them.

## Who wrote it

Each write is stamped with an actor:

- an agent's token name and client version, for example `claude-code/2.1.0`;
- `process:<name>` for tokens marked as an automated process;
- `human:<your ID>` for your approvals, reverts and, with **Record your edits** on, your own edits.

The note's `generated` field holds the last writer. The bundle's `log.md` holds every change with
its reason, and the plugin keeps an audit log and a snapshot of each agent write for 7 days.

## Trust you can check

OKF Wiki remembers the `status` and `verified` it last saw for each note. If someone changes them
outside the plugin, for example on another device or with a script, the note's badge in the status
bar shows `changed outside the plugin` instead of trusting the new values.

A note also returns to your review queue when it is past its `stale_after` date, when it changed
after it was verified, or when an agent asked for review.

## Limits

- Trust is a record, not a proof: it says who checked a note, not that the note is right.
- Snapshots for revert are kept for 7 days.

## Related

- [Review and approve agent drafts](../how-to/review-and-approve-agent-drafts.md)
- [Turn on auto approve](../how-to/turn-on-auto-approve.md)
- [Undo an agent change](../how-to/undo-an-agent-change.md)
