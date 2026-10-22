// Reject (DESIGN.md §9): ask the person why, then revert the agent's latest change to the note.

import { Modal, Setting, type App } from "obsidian";

export class RejectModal extends Modal {
  private reason = "";

  constructor(app: App, private readonly conceptId: string, private readonly onReject: (reason: string) => Promise<void>) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`Reject ${this.conceptId}?`);
    this.contentEl.createEl("p", {
      text: "Undoes the agent's latest change to this note: a new draft goes to the trash, an edit is rolled back. Your reason is written to log.md, where agents read it.",
    });
    new Setting(this.contentEl).setName("Reason").addTextArea((t) => t.setPlaceholder("What is wrong, so the agent can do better").onChange((v) => (this.reason = v)));
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Reject").setDestructive().onClick(async () => {
          if (!this.reason.trim()) return;
          this.close();
          await this.onReject(this.reason);
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
