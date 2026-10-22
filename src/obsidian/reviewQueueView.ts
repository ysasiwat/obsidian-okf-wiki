// Review Queue (DESIGN.md §9): concepts a person should look at, with Open, Approve (one or
// several at once), Reject and, for edited raw sources, Accept.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import type OkfWikiPlugin from "../main";
import { humanActor } from "./settings";
import { ConfirmModal } from "./settingsTab";

export const REVIEW_QUEUE_VIEW = "okf-wiki-review-queue";

type Item = ReturnType<OkfWikiPlugin["service"]["reviewQueue"]>[number];

/** Reasons "Select all without errors" may approve in one go. */
const BATCHABLE = new Set(["draft", "changed since verified"]);

export class ReviewQueueView extends ItemView {
  private selected = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OkfWikiPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return REVIEW_QUEUE_VIEW;
  }

  override getDisplayText(): string {
    return "Review queue";
  }

  override getIcon(): string {
    return "list-checks";
  }

  override async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    const items = this.plugin.service.reviewQueue();
    el.createEl("h4", { text: `Review queue (${items.length})` });
    if (items.length === 0) {
      el.createEl("p", { text: "Nothing to review.", cls: "setting-item-description" });
      return;
    }
    const key = (i: Item) => `${i.bundle}/${i.concept_id}`;
    const approvable = items.filter((i) => i.zone === "curated");
    this.selected = new Set([...this.selected].filter((k) => approvable.some((i) => key(i) === k)));
    const bar = el.createDiv({ cls: "okf-wiki-review-bar" });
    bar.createEl("button", { text: "Select all without errors" }).addEventListener("click", () => {
      // Review requests stay out: the agent asked for a person to read those.
      this.selected = new Set(approvable.filter((i) => i.reasons.every((r) => BATCHABLE.has(r))).map(key));
      this.render();
    });
    const approve = bar.createEl("button", { text: `Approve selected (${this.selected.size})`, cls: "mod-cta" });
    approve.disabled = this.selected.size === 0;
    approve.addEventListener("click", () => {
      const chosen = approvable.filter((i) => this.selected.has(key(i)));
      new ConfirmModal(this.app, `Approve ${chosen.length} note(s) as ${humanActor(this.plugin.settings)}? Each becomes stable and human-reviewed, as if you approved it on its own.`, async () => {
        this.selected.clear();
        await this.plugin.approveMany(chosen);
      }, "Approve").open();
    });
    for (const item of items) {
      const row = el.createDiv({ cls: "okf-wiki-review-item" });
      if (item.zone === "curated") {
        const box = row.createEl("input", { type: "checkbox" });
        box.checked = this.selected.has(key(item));
        box.addEventListener("change", () => {
          if (box.checked) this.selected.add(key(item));
          else this.selected.delete(key(item));
          approve.setText(`Approve selected (${this.selected.size})`);
          approve.disabled = this.selected.size === 0;
        });
      }
      const title = row.createEl("a", { text: item.title, href: "#" });
      title.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(`${item.bundle}/${item.concept_id}.md`, "", false);
      });
      row.createDiv({ text: `${item.bundle}/${item.concept_id} · ${item.reasons.join(", ")}`, cls: "setting-item-description" });
      const buttons = row.createDiv({ cls: "okf-wiki-review-actions" });
      if (item.zone === "curated") {
        buttons.createEl("button", { text: "Approve" }).addEventListener("click", () => void this.plugin.humanWrite(item.bundle, { kind: "verify", conceptId: item.concept_id, approve: true }, "Approved"));
      }
      buttons.createEl("button", { text: "Reject" }).addEventListener("click", () => this.plugin.openReject(item.bundle, item.concept_id));
      if (item.reasons.includes("raw-modified")) {
        buttons.createEl("button", { text: "Accept raw edit" }).addEventListener("click", () => void this.plugin.humanWrite(item.bundle, { kind: "rehash", conceptId: item.concept_id }, "Accepted the raw edit"));
      }
    }
  }
}
