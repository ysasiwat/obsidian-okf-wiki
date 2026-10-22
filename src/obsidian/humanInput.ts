// When did a person last type in a file? ADR 0003 (S3): `editor-change` fires for every
// change to an open file (sync, git, renames, our own writes), but CodeMirror transactions
// from the keyboard and mouse carry a userEvent ("input.type", "delete.backward", "undo",
// "move.drop", ...), while reloads from disk are "set" and plugin writes carry none.

import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { isHumanUserEvent } from "./userEvents";

export class HumanInputTracker {
  private last = new Map<string, number>();
  /** Files a person edited whose edit is not yet recorded in `generated`. */
  private unstamped = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Editor extension to register with Plugin.registerEditorExtension. */
  readonly extension = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (!update.transactions.some((tr) => tr.docChanged && isHumanUserEvent(tr.annotation(Transaction.userEvent)))) return;
    const path = update.state.field(editorInfoField, false)?.file?.path;
    if (path) {
      this.last.set(path, this.now());
      this.unstamped.add(path);
    }
  });

  /** Milliseconds since a person typed in the file at `vaultPath`, or null. */
  msSince(vaultPath: string): number | null {
    const t = this.last.get(vaultPath);
    return t === undefined ? null : this.now() - t;
  }

  forget(vaultPath: string): void {
    this.last.delete(vaultPath);
    this.unstamped.delete(vaultPath);
  }

  pendingStamps(): string[] {
    return [...this.unstamped];
  }

  stamped(vaultPath: string): void {
    this.unstamped.delete(vaultPath);
  }
}
