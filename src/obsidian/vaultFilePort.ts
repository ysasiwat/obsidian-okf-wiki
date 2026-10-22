// FilePort over Obsidian (ADR 0003, S2):
// - a file open in an editor is read from and written to the editor buffer, as one
//   minimal CodeMirror change kept out of the person's undo history, then saved;
// - any other file is written with vault.process, which re-checks the etag atomically;
// - renames use vault.rename, which leaves links alone (the planner rewrites them).

import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, TFile, TFolder, type App } from "obsidian";
import { applyChange, minimalChange } from "../core/textDiff";
import { etagOf } from "../core/write";
import { WriteConflict, type FilePort } from "../service/types";
import type { HumanInputTracker } from "./humanInput";

export class VaultFilePort implements FilePort {
  constructor(
    private readonly app: App,
    private readonly tracker: HumanInputTracker,
  ) {}

  private vaultPath(bundle: string, path: string): string {
    return `${bundle}/${path}`;
  }

  /** The editor view of an open file, if any. */
  private openView(vaultPath: string): { view: MarkdownView; cm: EditorView } | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === vaultPath) {
        const cm = (view.editor as unknown as { cm?: EditorView }).cm;
        if (cm) return { view, cm };
      }
    }
    return null;
  }

  private file(vaultPath: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(vaultPath);
    return f instanceof TFile ? f : null;
  }

  async read(bundle: string, path: string): Promise<string | undefined> {
    const vp = this.vaultPath(bundle, path);
    const open = this.openView(vp);
    if (open) return open.cm.state.doc.toString();
    const f = this.file(vp);
    return f ? this.app.vault.read(f) : undefined;
  }

  async write(bundle: string, path: string, text: string, expectedEtag: string | null): Promise<void> {
    const vp = this.vaultPath(bundle, path);
    const f = this.file(vp);
    if (expectedEtag === null && f) throw new WriteConflict(`${path} already exists`);
    if (expectedEtag !== null && !f) throw new WriteConflict(`${path} no longer exists`);

    const open = this.openView(vp);
    if (open) {
      const current = open.cm.state.doc.toString();
      if (expectedEtag !== null && etagOf(current) !== expectedEtag) throw new WriteConflict(`${path} changed in the editor`);
      const change = minimalChange(current, text);
      if (change) {
        // filter: false, because Obsidian's change filters drop programmatic edits to frontmatter
        // shown as Properties (live test of Approve); the change is exact and checked below.
        open.cm.dispatch({ changes: change, annotations: Transaction.addToHistory.of(false), filter: false });
        if (applyChange(current, change) !== open.cm.state.doc.toString()) throw new Error(`editor write of ${path} did not apply cleanly`);
      }
      await open.view.save();
      return;
    }

    if (!f) {
      const folder = vp.slice(0, vp.lastIndexOf("/"));
      await this.ensureFolder(folder);
      await this.withFolderOnDisk(folder, () => this.app.vault.create(vp, text));
      return;
    }
    await this.app.vault.process(f, (data) => {
      if (etagOf(data) !== expectedEtag) throw new WriteConflict(`${path} changed on disk`);
      return text;
    });
  }

  async rename(bundle: string, from: string, to: string): Promise<void> {
    const f = this.file(this.vaultPath(bundle, from));
    if (!f) throw new WriteConflict(`${from} no longer exists`);
    const target = this.vaultPath(bundle, to);
    if (this.app.vault.getAbstractFileByPath(target)) throw new WriteConflict(`${to} already exists`);
    const folder = target.slice(0, target.lastIndexOf("/"));
    await this.ensureFolder(folder);
    await this.withFolderOnDisk(folder, () => this.app.vault.rename(f, target));
  }

  /**
   * Obsidian's file cache can still list a folder that is gone on disk (moved away and recreated
   * while Obsidian runs), so ensureFolder skips it and the write fails with ENOENT. Then make the
   * folder on disk and retry once; any other failure is rethrown as is.
   */
  private async withFolderOnDisk(folder: string, op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (e) {
      if (!folder || !/ENOENT/.test(e instanceof Error ? e.message : String(e))) throw e;
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(folder)) throw e;
      await adapter.mkdir(folder);
      await op();
    }
  }

  async trash(bundle: string, path: string): Promise<void> {
    const f = this.file(this.vaultPath(bundle, path));
    if (f) await this.app.fileManager.trashFile(f);
  }

  msSinceHumanInput(bundle: string, path: string): number | null {
    return this.tracker.msSince(this.vaultPath(bundle, path));
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return;
    if (existing) throw new WriteConflict(`${folder} is a file, not a folder`);
    await this.ensureFolder(folder.slice(0, Math.max(0, folder.lastIndexOf("/"))));
    await this.app.vault.createFolder(folder);
  }
}
