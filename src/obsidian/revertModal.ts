// "Revert an agent change…": pick a recent commit, confirm, undo it (DESIGN.md §6.7).

import { Modal, Notice, Setting, SuggestModal, type App } from "obsidian";
import type { CommitRecord, SnapshotStore } from "../service/types";

export class RevertModal extends SuggestModal<CommitRecord> {
  private records: CommitRecord[] = [];

  constructor(app: App, private readonly snapshots: SnapshotStore, private readonly onRevert: (id: string) => Promise<void>) {
    super(app);
    this.setPlaceholder("Pick a change to revert (snapshots are kept for 7 days)");
  }

  override onOpen(): void {
    void super.onOpen();
    void this.snapshots.list(100).then((r) => {
      this.records = r.filter((x) => x.tool !== "revert");
      if (this.records.length === 0) new Notice("OKF Wiki: no recent changes to revert.");
      // Re-run the query so the list fills in once loaded.
      this.inputEl.dispatchEvent(new Event("input"));
    });
  }

  getSuggestions(query: string): CommitRecord[] {
    const q = query.toLowerCase();
    return this.records.filter((r) => `${r.conceptId} ${r.token ?? ""} ${r.tool} ${r.reason ?? ""}`.toLowerCase().includes(q));
  }

  renderSuggestion(r: CommitRecord, el: HTMLElement): void {
    el.createDiv({ text: `${r.conceptId} · ${r.tool}` });
    el.createEl("small", { text: `${new Date(r.at).toLocaleString()} · ${r.token ?? r.actor}${r.reason ? ` · ${r.reason}` : ""}` });
  }

  onChooseSuggestion(r: CommitRecord): void {
    new ConfirmRevert(this.app, r, () => this.onRevert(r.id)).open();
  }
}

class ConfirmRevert extends Modal {
  constructor(app: App, private readonly record: CommitRecord, private readonly onConfirm: () => Promise<void>) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Revert this change?");
    const files = this.record.files.map((f) => f.path).filter((p) => p !== "log.md" && !p.endsWith("index.md"));
    this.contentEl.createEl("p", { text: `${this.record.tool} on ${this.record.conceptId} by ${this.record.token ?? this.record.actor}, ${new Date(this.record.at).toLocaleString()}.` });
    this.contentEl.createEl("p", { text: `Files restored: ${files.join(", ") || "none"}. Indexes and the log are regenerated. It is refused if any of these files changed since.` });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Revert").setDestructive().onClick(async () => {
          this.close();
          await this.onConfirm();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
