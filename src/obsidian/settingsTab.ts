// Settings UI: server, bundles, tokens. Built only from Obsidian's Setting API and
// createEl, never innerHTML.

import { App, Modal, Notice, PluginSettingTab, Setting, TFolder, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { createTokenRecord, tokenNameErrors } from "../server/tokens";
import type OkfWikiPlugin from "../main";
import type { Scope } from "../service/types";
import { RevertModal } from "./revertModal";
import { clientSnippets, endpointUrl, USER_ID } from "./settings";
import { bundlePathErrors } from "./vaultBundleSource";

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Extra scopes a token may be given; read is always included. */
const EXTRA_SCOPES: { scope: Scope; name: string; desc: string }[] = [
  { scope: "write", name: "Write", desc: "Create, update, move and deprecate concepts and ingest raw sources. New concepts are drafts." },
  { scope: "publish", name: "Publish", desc: "Make drafts stable without a person's review. Only for trusted processes." },
  { scope: "raw:write", name: "Replace raw sources", desc: "Overwrite write-once raw sources." },
  { scope: "computations:write", name: "Edit computations", desc: "Author or change sanctioned Attested Computations." },
];

function blankToken(): { name: string; bundles: string; pathPrefixes: string; scopes: Set<Scope>; process: boolean } {
  return { name: "", bundles: "", pathPrefixes: "", scopes: new Set<Scope>(), process: false };
}

/**
 * One row, searchable by its name and description, whose controls are built imperatively so the
 * validation and side effects stay in one place. Name and description are set again on the row
 * because a render item draws its own content.
 */
function row(name: string, desc: string | undefined, add: (setting: Setting) => unknown = () => undefined): SettingDefinition {
  return {
    name,
    ...(desc ? { desc } : {}),
    render: (setting) => {
      setting.setName(name);
      if (desc) setting.setDesc(desc);
      add(setting);
    },
  };
}

/** A text box that commits on change (not on every keystroke) and rejects invalid input. */
function commitOnChange(setting: Setting, value: string, commit: (v: string) => Promise<boolean>, placeholder = ""): void {
  setting.addText((t) => {
    t.setPlaceholder(placeholder).setValue(value);
    t.inputEl.addEventListener("change", () => void (async () => {
      if (!(await commit(t.getValue()))) t.setValue(value);
    })());
  });
}

export class OkfWikiSettingTab extends PluginSettingTab {
  private newBundlePath = "";
  private newToken = blankToken();

  constructor(app: App, private readonly plugin: OkfWikiPlugin) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [this.serverGroup(), this.bundleGroup(), this.writesGroup(), this.autoApproveGroup(), this.tokenGroup(), this.newTokenGroup(), this.advancedGroup()];
  }

  private async save(applyServer = false): Promise<void> {
    await this.plugin.saveSettings();
    if (applyServer) await this.plugin.applyServerState();
    this.update();
  }

  private serverGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const status = this.plugin.serverError
      ? `Error: ${this.plugin.serverError}`
      : this.plugin.server
        ? `Running at ${endpointUrl(s.port)} (loopback only).`
        : s.serverEnabled
          ? "Stopped: create a token to start the server."
          : "Stopped.";
    return {
      type: "group",
      heading: "MCP server",
      items: [
        row("Status", status),
        row("Enable server", "Serve the MCP endpoint on 127.0.0.1. It never listens on other interfaces.", (setting) =>
          setting.addToggle((t) =>
            t.setValue(s.serverEnabled).onChange(async (v) => {
              s.serverEnabled = v;
              await this.save(true);
            }),
          ),
        ),
        row("Port", "1024-65535. Restarts the server.", (setting) =>
          commitOnChange(setting, String(s.port), async (v) => {
            const port = Number(v);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
              new Notice("Port must be a whole number from 1024 to 65535.");
              return false;
            }
            s.port = port;
            await this.save(true);
            return true;
          }),
        ),
      ],
    };
  }

  private bundleGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const items: SettingDefinition[] = [row("Served folders", "Folders served as OKF bundles. Agents see nothing outside them.")];
    if (s.bundles.length === 0) items.push(row("No bundles yet", "Add a folder below."));
    for (const b of s.bundles) {
      const model = this.plugin.source.bundles().find((h) => h.name === b.path)?.model;
      items.push(row(b.path, model ? `${model.concepts.size} concepts` : b.enabled ? "Loading…" : "Disabled", (setting) =>
        setting
          .addToggle((t) =>
            t.setValue(b.enabled).onChange(async (v) => {
              b.enabled = v;
              await this.plugin.saveSettings();
              await this.plugin.reloadBundles();
              this.update();
            }),
          )
          .addExtraButton((x) =>
            x.setIcon("trash").setTooltip("Stop serving this folder (files are not touched)").onClick(async () => {
              s.bundles = s.bundles.filter((y) => y !== b);
              await this.plugin.saveSettings();
              await this.plugin.reloadBundles();
              this.update();
            }),
          ),
      ));
    }
    for (const d of this.plugin.discovered.filter((x) => !s.bundles.some((b) => b.path === x))) {
      items.push(row(`Found: ${d}`, "This folder declares itself an OKF bundle.", (setting) =>
        setting
          .addButton((btn) => btn.setButtonText("Enable").setCta().onClick(() => this.addBundle(d)))
          .addButton((btn) =>
            btn.setButtonText("Dismiss").onClick(async () => {
              s.dismissedBundles.push(d);
              this.plugin.discovered = this.plugin.discovered.filter((x) => x !== d);
              await this.save();
            }),
          ),
      ));
    }
    items.push(row("Add a folder", "Vault-relative folder path, such as Knowledge. Nothing in the folder is changed.", (setting) =>
      setting
        .addText((t) => t.setPlaceholder("Knowledge").setValue(this.newBundlePath).onChange((v) => (this.newBundlePath = v)))
        .addButton((btn) => btn.setButtonText("Add").onClick(() => this.addBundle(this.newBundlePath))),
    ));
    return { type: "group", heading: "Bundles", items };
  }

  private async addBundle(path: string): Promise<void> {
    const s = this.plugin.settings;
    const clean = path.trim().replace(/^\/+|\/+$/g, "");
    const errors = bundlePathErrors(clean, s.bundles.map((b) => b.path), {
      configDir: this.app.vault.configDir,
      isFolder: (p) => this.app.vault.getAbstractFileByPath(p) instanceof TFolder,
    });
    if (errors.length > 0) {
      new Notice(errors.join(" "));
      return;
    }
    s.bundles.push({ path: clean, enabled: true });
    this.newBundlePath = "";
    await this.plugin.saveSettings();
    await this.plugin.reloadBundles();
    this.update();
  }

  private tokenGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const items: SettingDefinition[] = [
      row("About tokens", "Each agent gets its own token. Only a hash is stored, so a token is shown once, when it is created. Every token can read; give write access only to agents you trust to draft."),
    ];
    for (const t of s.tokens) {
      const where = t.bundles === "*" ? "all bundles" : t.bundles.join(", ") || "no bundles";
      const paths = t.pathPrefixes.length ? `; paths: ${t.pathPrefixes.join(", ")}` : "";
      const used = t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used";
      items.push(row(t.name, `${t.scopes.join(", ")} · ${where}${paths} · created ${new Date(t.createdAt).toLocaleDateString()} · ${used}`, (setting) =>
        setting.addButton((btn) =>
          btn.setButtonText("Revoke").setDestructive().onClick(() => {
            new ConfirmModal(this.app, `Revoke token '${t.name}'? Agents using it lose access immediately.`, async () => {
              s.tokens = s.tokens.filter((x) => x.id !== t.id);
              s.autoApprove.tokens = s.autoApprove.tokens.filter((n) => n !== t.name);
              this.plugin.server?.dropSessionsFor(t.id);
              await this.save(s.tokens.length === 0);
            }).open();
          }),
        ),
      ));
    }
    return { type: "group", heading: "Access tokens", items };
  }

  private newTokenGroup(): SettingDefinitionItem {
    const items: SettingDefinition[] = [
      row("New token name", "Lowercase letters, digits, '.', '_' or '-'. It identifies the agent in logs, such as claude-code.", (setting) =>
        setting.addText((t) => t.setPlaceholder("claude-code").setValue(this.newToken.name).onChange((v) => (this.newToken.name = v.trim()))),
      ),
      row("Limit to bundles", "Comma-separated bundle folders. Empty means all bundles.", (setting) =>
        setting.addText((t) => t.setValue(this.newToken.bundles).onChange((v) => (this.newToken.bundles = v))),
      ),
      row("Limit to paths", "Comma-separated folders inside the bundles, such as concepts and decisions. Empty means everything.", (setting) =>
        setting.addText((t) => t.setValue(this.newToken.pathPrefixes).onChange((v) => (this.newToken.pathPrefixes = v))),
      ),
      ...EXTRA_SCOPES.map((x) =>
        row(`Scope: ${x.name}`, x.desc, (setting) =>
          setting.addToggle((t) =>
            t.setValue(this.newToken.scopes.has(x.scope)).onChange((v) => {
              if (v) this.newToken.scopes.add(x.scope);
              else this.newToken.scopes.delete(x.scope);
            }),
          ),
        ),
      ),
      row("Automated process", "Writes are stamped process:<name> instead of <name>/<version>.", (setting) =>
        setting.addToggle((t) => t.setValue(this.newToken.process).onChange((v) => (this.newToken.process = v))),
      ),
      row("Create the token", undefined, (setting) => setting.addButton((btn) => btn.setButtonText("Create token").setCta().onClick(() => this.createToken()))),
    ];
    return { type: "group", heading: "New token", items };
  }

  private writesGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const num = (name: string, desc: string, get: () => number, set: (n: number) => void, max: number) =>
      row(name, desc, (setting) =>
        commitOnChange(setting, String(get()), async (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > max) {
            new Notice(`${name}: a whole number from 1 to ${max}.`);
            return false;
          }
          set(n);
          await this.save();
          return true;
        }),
      );
    return {
      type: "group",
      heading: "Agent writes",
      items: [
        row("Pause agent writes", "Refuse every write from agents at once. Reads keep working. Also a command and shown in the status bar.", (setting) =>
          setting.addToggle((t) => t.setValue(s.agentWritesPaused).onChange((v) => void this.plugin.setWritesPaused(v))),
        ),
        num("Writes per minute", "Per token.", () => s.writesPerMinute, (n) => (s.writesPerMinute = n), 1000),
        num("Writes per day", "Per token.", () => s.writesPerDay, (n) => (s.writesPerDay = n), 100_000),
        row("Your ID", "Recorded as human:<id> when you approve notes, revert changes and edit notes. Letters, digits, . _ @ + -", (setting) =>
          commitOnChange(setting, s.userId, async (raw) => {
            const v = raw.trim();
            if (v && !USER_ID.test(v)) {
              new Notice("Your ID: letters, digits and . _ @ + - only, starting with a letter or digit.");
              return false;
            }
            s.userId = v;
            await this.save();
            return true;
          }, "your-name"),
        ),
        row("Record your edits", "When you edit a note in a bundle, record you in its generated field once you leave the note or stop typing for a minute. Needs your ID.", (setting) =>
          setting.addToggle((t) =>
            t.setValue(s.stampHumanEdits).onChange(async (v) => {
              s.stampHumanEdits = v;
              await this.save();
            }),
          ),
        ),
        row("Snapshots and audit", `Kept in ${this.plugin.manifest.dir ?? "the plugin folder"}/state for 7 days. If your vault's .obsidian folder is in git, add that folder to .gitignore.`, (setting) =>
          setting.addButton((b) => b.setButtonText("Revert a change…").onClick(() => new RevertModal(this.app, this.plugin.snapshots, (id) => this.plugin.revert(id)).open())),
        ),
      ],
    };
  }

  private autoApproveGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const a = s.autoApprove;
    return {
      type: "group",
      heading: "Auto approve",
      items: [
        row("Approve clean agent writes", "When a listed token creates or updates a note that has sources cited in footnotes, no lint warnings and no review request, approve it at once as process:auto-approve (machine-confirmed, not human-reviewed). Notes you approved yourself always come back to you.", (setting) =>
          setting.addToggle((t) =>
            t.setValue(a.enabled).onChange(async (v) => {
              a.enabled = v;
              await this.save();
            }),
          ),
        ),
        row("Tokens", "Comma-separated token names whose writes may be approved.", (setting) =>
          commitOnChange(setting, a.tokens.join(", "), async (v) => {
            const names = list(v);
            const unknown = names.filter((n) => !s.tokens.some((t) => t.name === n));
            if (unknown.length > 0) {
              new Notice(`Not a token: ${unknown.join(", ")}`);
              return false;
            }
            a.tokens = names;
            await this.save();
            return true;
          }, "claude-code"),
        ),
        row("Bundles", "Comma-separated bundle folders. Empty means every bundle.", (setting) =>
          commitOnChange(setting, a.bundles.join(", "), async (v) => {
            const names = list(v);
            const unknown = names.filter((n) => !s.bundles.some((b) => b.path === n));
            if (unknown.length > 0) {
              new Notice(`Not a bundle: ${unknown.join(", ")}`);
              return false;
            }
            a.bundles = names;
            await this.save();
            return true;
          }),
        ),
      ],
    };
  }

  private async createToken(): Promise<void> {
    const s = this.plugin.settings;
    const name = this.newToken.name;
    const errors = tokenNameErrors(name);
    if (errors.length > 0) return void new Notice(`Token name: ${errors.join(" ")}`);
    if (s.tokens.some((t) => t.name === name)) return void new Notice(`A token named '${name}' already exists.`);
    const bundles = list(this.newToken.bundles);
    const unknown = bundles.filter((b) => !s.bundles.some((x) => x.path === b));
    if (unknown.length > 0) return void new Notice(`Not a bundle: ${unknown.join(", ")}`);
    const { token, record } = createTokenRecord({
      name,
      kind: this.newToken.process ? "process" : "agent",
      scopes: ["read", ...this.newToken.scopes],
      bundles: bundles.length ? bundles : "*",
      pathPrefixes: list(this.newToken.pathPrefixes).map((p) => p.replace(/^\/+|\/+$/g, "")),
    });
    s.tokens.push(record);
    this.newToken = blankToken();
    await this.save(!this.plugin.server);
    new TokenCreatedModal(this.app, name, token, s.port).open();
  }

  private advancedGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    return {
      type: "group",
      heading: "Advanced",
      items: [
        row("Allowed browser origins", "Comma-separated hostnames whose web pages may call the server. Leave empty: MCP clients do not send an origin header, and any page that does is refused.", (setting) =>
          commitOnChange(setting, s.allowedOrigins.join(", "), async (v) => {
            s.allowedOrigins = list(v);
            await this.save(true);
            return true;
          }),
        ),
      ],
    };
  }
}

class TokenCreatedModal extends Modal {
  constructor(app: App, private readonly name: string, private readonly token: string, private readonly port: number) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`Token '${this.name}' created`);
    contentEl.createEl("p", { text: "Copy it now. Only a hash is kept, so it cannot be shown again; if you lose it, revoke it and create another." });
    const snippets = clientSnippets(this.port, this.token);
    this.block(contentEl, "Token", this.token);
    this.block(contentEl, "Claude Code", snippets.claudeCode);
    this.block(contentEl, ".mcp.json", snippets.mcpJson);
  }

  private block(el: HTMLElement, label: string, text: string): void {
    new Setting(el).setName(label).addButton((b) =>
      b.setButtonText("Copy").onClick(async () => {
        await navigator.clipboard.writeText(text);
        new Notice(`${label} copied.`);
      }),
    );
    el.createEl("pre", { text, cls: "okf-wiki-snippet" });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onConfirm: () => Promise<void>,
    /** A label for the confirming button; without one it is a red "Confirm". */
    private readonly action?: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(this.action ?? "Confirm").onClick(async () => {
          this.close();
          await this.onConfirm();
        });
        if (this.action) b.setCta();
        else b.setDestructive();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
