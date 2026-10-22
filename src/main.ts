// Obsidian entry point: wires the vault to the bundle source, the knowledge and write
// services and the loopback MCP server, and keeps the status bar current.

import { FileSystemAdapter, Notice, Plugin, TFile, TFolder, type EventRef } from "obsidian";
import { createDiskGuard } from "./obsidian/diskGuard";
import { HumanInputTracker } from "./obsidian/humanInput";
import { RejectModal } from "./obsidian/rejectModal";
import { RevertModal } from "./obsidian/revertModal";
import { endpointUrl, humanActor, sanitizeSettings, type PluginSettings } from "./obsidian/settings";
import { OkfWikiSettingTab } from "./obsidian/settingsTab";
import { FileAuditLog, FileSnapshotStore, FileTrustLedger, type StateAdapter } from "./obsidian/stateStore";
import { REVIEW_QUEUE_VIEW, ReviewQueueView } from "./obsidian/reviewQueueView";
import { isStale, trustFingerprint, trustTier } from "./core/trust";
import type { WriteRequest } from "./core/write";
import { VaultBundleSource, type VaultPort } from "./obsidian/vaultBundleSource";
import { VaultFilePort } from "./obsidian/vaultFilePort";
import { OkfHttpServer } from "./server/httpServer";
import { TokenStore } from "./server/tokens";
import { autoApproveRule } from "./service/autoApprove";
import { KnowledgeService } from "./service/knowledgeService";
import { WriteService } from "./service/writeService";
import { ExtensionHost, type OkfWikiApi } from "./api";

const LOG_PREFIX = "[okf-wiki]";

/** Resume on a later tick, so Obsidian can paint and handle input in between. */
const nextTick = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

export default class OkfWikiPlugin extends Plugin {
  declare settings: PluginSettings;
  source!: VaultBundleSource;
  service!: KnowledgeService;
  writes!: WriteService;
  private extensions!: ExtensionHost;
  /** For other plugins: app.plugins.plugins["okf-wiki"].api (DESIGN.md §13 4C). */
  api!: OkfWikiApi;
  snapshots!: FileSnapshotStore;
  trust!: FileTrustLedger;
  private tracker!: HumanInputTracker;
  private badgeEl: HTMLElement | null = null;
  tokens!: TokenStore;
  server: OkfHttpServer | null = null;
  serverError: string | null = null;
  discovered: string[] = [];
  private statusEl: HTMLElement | null = null;
  private usageDirty = false;
  private serverQueue: Promise<void> = Promise.resolve();
  private unloaded = false;

  override async onload(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
    this.source = new VaultBundleSource(this.createVaultPort(), () => this.settings.bundles, {
      log: (m, e) => console.warn(LOG_PREFIX, m, e ?? ""),
      onUpdate: () => this.refreshViews(),
      pause: nextTick,
    });
    const stateDir = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/state`;
    const adapter = this.app.vault.adapter as unknown as StateAdapter;
    this.trust = new FileTrustLedger(adapter, stateDir);
    await this.trust.load();
    this.registerInterval(window.setInterval(() => void this.trust.flush(), 5_000));
    this.service = new KnowledgeService(this.source, undefined, this.trust);
    this.extensions = new ExtensionHost(this.service, (m, e) => console.warn(LOG_PREFIX, m, e ?? ""));
    this.api = this.extensions.api;

    // Writes (DESIGN.md §6): a person's typing is tracked from CodeMirror user events so
    // agent writes wait while someone edits a note; snapshots and audit live in state/.
    const tracker = (this.tracker = new HumanInputTracker());
    this.registerEditorExtension(tracker.extension);
    this.snapshots = new FileSnapshotStore(adapter, `${stateDir}/snapshots`);
    this.writes = new WriteService(this.source, new VaultFilePort(this.app, tracker), this.snapshots, new FileAuditLog(adapter, stateDir), {
      paused: () => this.settings.agentWritesPaused,
      perMinute: () => this.settings.writesPerMinute,
      perDay: () => this.settings.writesPerDay,
      log: (m, e) => console.warn(LOG_PREFIX, m, e ?? ""),
      trust: this.trust,
      onCommit: (e) => this.extensions.emit(e),
      autoApprove: autoApproveRule(this.service, () => this.settings.autoApprove),
    });

    // Human in the loop (DESIGN.md §5, §9).
    this.registerView(REVIEW_QUEUE_VIEW, (leaf) => new ReviewQueueView(leaf, this));
    this.badgeEl = this.addStatusBarItem();
    this.registerInterval(window.setInterval(() => void this.stampPendingEdits(), 10_000));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.stampPendingEdits();
        this.refreshBadge();
      }),
    );
    this.addCommand({ id: "open-review-queue", name: "Open review queue", callback: () => void this.openReviewQueue() });
    this.addCommand({ id: "approve-note", name: "Approve this note", checkCallback: this.onActive((b, id) => this.humanWrite(b, { kind: "verify", conceptId: id, approve: true }, "approved")) });
    this.addCommand({ id: "reject-note", name: "Reject the agent's latest change to this note…", checkCallback: this.onActive(async (b, id) => this.openReject(b, id)) });
    this.addCommand({ id: "accept-raw-edit", name: "Accept edits to this raw source", checkCallback: this.onActive((b, id) => this.humanWrite(b, { kind: "rehash", conceptId: id }, "accepted the raw edit")) });
    this.addCommand({ id: "convert-links", name: "Convert links in this bundle to OKF form", checkCallback: this.onActive((b) => this.convertLinks(b)) });
    this.tokens = new TokenStore(
      () => this.settings.tokens,
      (record) => {
        record.lastUsedAt = new Date().toISOString();
        this.usageDirty = true;
      },
    );
    // Persist last-used times at most once a minute rather than on every request.
    this.registerInterval(
      window.setInterval(() => {
        if (this.usageDirty) {
          this.usageDirty = false;
          void this.saveData(this.settings);
        }
      }, 60_000),
    );

    this.addSettingTab(new OkfWikiSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.refreshStatus();

    this.addCommand({
      id: "reload-bundles",
      name: "Reload OKF bundles",
      callback: () => void this.reloadBundles(),
    });
    this.addCommand({
      id: "copy-endpoint",
      name: "Copy MCP endpoint URL",
      callback: () => {
        void navigator.clipboard.writeText(endpointUrl(this.settings.port));
        new Notice("MCP endpoint URL copied.");
      },
    });
    this.addCommand({
      id: "restart-server",
      name: "Restart MCP server",
      callback: () => void this.applyServerState("command"),
    });
    this.addCommand({
      id: "toggle-agent-writes",
      name: "Pause or resume agent writes",
      callback: () => void this.setWritesPaused(!this.settings.agentWritesPaused),
    });
    this.addCommand({
      id: "revert-agent-change",
      name: "Revert an agent change…",
      callback: () => new RevertModal(this.app, this.snapshots, (id) => this.revert(id)).open(),
    });

    this.app.workspace.onLayoutReady(async () => {
      await this.reloadBundles();
      await this.applyServerState("startup");
      this.discovered = (await this.source.discover()).filter((d) => !this.settings.dismissedBundles.includes(d));
      if (this.discovered.length > 0) {
        new Notice(`OKF Wiki found ${this.discovered.length} OKF bundle(s) that are not enabled. Review them in the plugin settings.`);
      }
    });
  }

  override onunload(): void {
    this.extensions?.dispose();
    // Obsidian does not await onunload, and a reload starts the next instance at once:
    // release the port before anything else.
    this.unloaded = true;
    const stopping = this.server?.stop();
    this.server = null;
    if (stopping) console.debug(LOG_PREFIX, "MCP server stopped (unload)");
    this.source?.dispose();
    void Promise.allSettled([stopping, this.trust?.flush()]);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** The bundle and concept id of a vault path in an enabled bundle. */
  locate(vaultPath: string): { bundle: string; conceptId: string } | null {
    const b = this.source.bundles().find((x) => vaultPath.startsWith(`${x.name}/`));
    return b && vaultPath.endsWith(".md") ? { bundle: b.name, conceptId: vaultPath.slice(b.name.length + 1, -3) } : null;
  }

  /** A checkCallback that offers the command only while the active note is in an enabled bundle. */
  private onActive(fn: (bundle: string, conceptId: string) => Promise<unknown>): (checking: boolean) => boolean {
    return (checking) => {
      const f = this.app.workspace.getActiveFile();
      const loc = f ? this.locate(f.path) : null;
      if (!loc) return false;
      if (!checking) void fn(loc.bundle, loc.conceptId);
      return true;
    };
  }

  /** A write by the owner; needs their id so every human: actor is attributable. Throws on failure. */
  private async ownerWrite(bundle: string, req: WriteRequest): Promise<boolean> {
    if (!this.settings.userId) throw new Error("Set your ID in the plugin settings first (Agent writes > Your ID).");
    const r = await this.writes.write({ kind: "human", actor: humanActor(this.settings) }, bundle, req, req.kind);
    return r.changed;
  }

  async humanWrite(bundle: string, req: WriteRequest, done: string): Promise<void> {
    try {
      new Notice(`OKF Wiki: ${(await this.ownerWrite(bundle, req)) ? done : "nothing to change"}.`);
    } catch (e) {
      new Notice(`OKF Wiki: ${(e as Error).message}`);
    }
    this.refreshViews();
  }

  /** Approve several notes as the owner (Review Queue). */
  async approveMany(items: { bundle: string; concept_id: string }[]): Promise<void> {
    let approved = 0;
    const failed: string[] = [];
    for (const item of items) {
      try {
        if (await this.ownerWrite(item.bundle, { kind: "verify", conceptId: item.concept_id, approve: true })) approved++;
      } catch (e) {
        failed.push(`${item.concept_id}: ${(e as Error).message}`);
      }
    }
    new Notice(`OKF Wiki: approved ${approved} of ${items.length} note(s).${failed.length ? ` Failed: ${failed.join("; ")}` : ""}`);
    this.refreshViews();
  }

  /** Ask for a reason, then undo the agent's latest change to the note (DESIGN.md §9). */
  openReject(bundle: string, conceptId: string): void {
    if (!this.settings.userId) return void new Notice("OKF Wiki: set your ID in the plugin settings first.");
    new RejectModal(this.app, conceptId, async (reason) => {
      try {
        const r = await this.writes.reject(humanActor(this.settings), bundle, conceptId, reason);
        new Notice(`OKF Wiki: rejected; restored ${r.files.length} file(s).`);
      } catch (e) {
        new Notice(`OKF Wiki: could not reject: ${(e as Error).message}`);
      }
      this.refreshViews();
    }).open();
  }

  /** Record a person's edits once they leave the note or stop typing for a minute. */
  private async stampPendingEdits(): Promise<void> {
    if (!this.settings.stampHumanEdits || !this.settings.userId) return;
    const active = this.app.workspace.getActiveFile()?.path;
    for (const path of this.tracker.pendingStamps()) {
      if (path === active && (this.tracker.msSince(path) ?? Infinity) < 60_000) continue;
      this.tracker.stamped(path);
      const loc = this.locate(path);
      if (!loc) continue;
      try {
        await this.ownerWrite(loc.bundle, { kind: "stamp", conceptId: loc.conceptId });
      } catch (e) {
        // index.md, log.md and notes whose YAML does not parse are not stamped.
        console.warn(LOG_PREFIX, `did not record the edit of ${path}`, e);
      }
    }
  }

  private async convertLinks(bundle: string): Promise<void> {
    const ids = [...(this.source.bundles().find((b) => b.name === bundle)?.model.concepts.values() ?? [])].map((c) => c.id);
    let changed = 0;
    for (const id of ids) {
      try {
        if (await this.ownerWrite(bundle, { kind: "convert_links", conceptId: id })) changed++;
      } catch (e) {
        console.warn(LOG_PREFIX, `could not convert links in ${id}`, e);
      }
    }
    new Notice(`OKF Wiki: converted links in ${changed} of ${ids.length} note(s).`);
  }

  async openReviewQueue(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW)[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: REVIEW_QUEUE_VIEW, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    this.refreshStatus();
    this.refreshBadge();
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW)) {
      if (leaf.view instanceof ReviewQueueView) leaf.view.render();
    }
  }

  /** Trust badge for the active note (DESIGN.md §9). */
  private refreshBadge(): void {
    if (!this.badgeEl) return;
    const f = this.app.workspace.getActiveFile();
    const loc = f ? this.locate(f.path) : null;
    const c = loc ? this.source.bundles().find((b) => b.name === loc.bundle)?.model.concepts.get(`${loc.conceptId}.md`) : undefined;
    if (!loc || !c) return void this.badgeEl.setText("");
    const parts = [c.status ?? "invalid status", trustTier(c.frontmatter)];
    if (isStale(c.frontmatter)) parts.push("stale");
    const fp = this.trust.get(loc.bundle, c.path);
    if (fp !== undefined && fp !== trustFingerprint(c.frontmatter)) parts.push("changed outside the plugin");
    this.badgeEl.setText(`OKF: ${parts.join(" · ")}`);
  }

  async setWritesPaused(paused: boolean): Promise<void> {
    this.settings.agentWritesPaused = paused;
    await this.saveSettings();
    this.refreshStatus();
    new Notice(paused ? "OKF Wiki: agent writes paused. Reads still work." : "OKF Wiki: agent writes resumed.");
  }

  async revert(commitId: string): Promise<void> {
    try {
      const r = await this.writes.revert(humanActor(this.settings), commitId);
      new Notice(`OKF Wiki: reverted ${r.files.length} file(s).`);
    } catch (e) {
      new Notice(`OKF Wiki: could not revert: ${(e as Error).message}`);
    }
  }

  async reloadBundles(): Promise<void> {
    await this.source.reload();
    this.refreshStatus();
    // Build the lint cache and search indexes now, a slice at a time, rather than in one
    // blocking go on the first request (DESIGN.md §13 4A).
    void this.service.warm(nextTick).catch((e) => console.warn(LOG_PREFIX, "could not prepare the bundles", e));
  }

  /**
   * Start, stop or restart the server to match the settings. Calls run one at a time: two
   * overlapping restarts (startup and a settings change) would race for the port.
   */
  applyServerState(reason = "settings"): Promise<void> {
    const run = this.serverQueue.then(() => this.applyServerStateNow(reason));
    this.serverQueue = run.catch(() => undefined);
    return run;
  }

  private async applyServerStateNow(reason: string): Promise<void> {
    if (this.unloaded) return;
    if (this.server) {
      await this.server.stop();
      this.server = null;
      console.debug(LOG_PREFIX, `MCP server stopped (${reason})`);
    }
    this.serverError = null;
    if (this.settings.serverEnabled && this.settings.tokens.length > 0) {
      const server = new OkfHttpServer({
        service: this.service,
        tokens: this.tokens,
        writes: this.writes,
        version: this.manifest.version,
        allowedOrigins: this.settings.allowedOrigins,
        log: (level, message, error) => (level === "error" ? console.error : console.warn)(LOG_PREFIX, message, error ?? ""),
        onUnexpectedClose: () => {
          if (this.server !== server) return;
          this.server = null;
          this.serverError = "The server stopped unexpectedly. Run 'Restart MCP server'.";
          new Notice(`OKF Wiki: ${this.serverError}`);
          this.refreshStatus();
        },
      });
      try {
        await server.start(this.settings.port);
        // Unloaded while the port was being acquired: nothing would ever stop this listener.
        if (this.unloaded) return void (await server.stop());
        this.server = server;
        console.debug(LOG_PREFIX, `MCP server listening on ${endpointUrl(this.settings.port)} (${reason})`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        this.serverError = code === "EADDRINUSE" ? `Port ${this.settings.port} is already in use.` : `Could not start the server: ${String(e)}`;
        console.error(LOG_PREFIX, this.serverError, e);
        new Notice(`OKF Wiki: ${this.serverError}`);
      }
    }
    this.refreshStatus();
  }

  refreshStatus(): void {
    if (!this.statusEl) return;
    const bundles = this.source?.bundles().length ?? 0;
    let text: string;
    if (this.serverError) text = "OKF MCP: error";
    else if (this.server && this.settings.agentWritesPaused) text = `OKF MCP :${this.settings.port} · writes paused`;
    else if (this.server) text = `OKF MCP :${this.settings.port} · ${bundles} bundle${bundles === 1 ? "" : "s"}`;
    else if (this.settings.serverEnabled && this.settings.tokens.length === 0) text = "OKF MCP: no tokens";
    else text = "OKF MCP: off";
    this.statusEl.setText(text);
    this.statusEl.setAttr("aria-label", this.serverError ?? endpointUrl(this.settings.port));
  }

  private createVaultPort(): VaultPort {
    const vault = this.app.vault;
    const adapter = vault.adapter;
    // Without filesystem access there is no way to verify real paths, so serve nothing.
    const guard = adapter instanceof FileSystemAdapter ? createDiskGuard(adapter.getBasePath(), vault.configDir) : () => false;
    return {
      configDir: vault.configDir,
      listFiles: () => vault.getFiles().map((f) => f.path),
      isFolder: (path) => vault.getAbstractFileByPath(path) instanceof TFolder,
      readText: async (path) => {
        const f = vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error(`not a file: ${path}`);
        return vault.cachedRead(f);
      },
      readHidden: async (path) => ((await adapter.exists(path)) ? adapter.read(path) : null),
      isSafeOnDisk: guard,
      onChange: (listener) => {
        const refs: EventRef[] = [
          vault.on("create", (f) => listener({ kind: "create", path: f.path })),
          vault.on("modify", (f) => listener({ kind: "modify", path: f.path })),
          vault.on("delete", (f) => listener({ kind: "delete", path: f.path })),
          vault.on("rename", (f, oldPath) => listener({ kind: "rename", path: f.path, oldPath })),
        ];
        for (const r of refs) this.registerEvent(r);
        return () => refs.forEach((r) => vault.offref(r));
      },
    };
  }
}
