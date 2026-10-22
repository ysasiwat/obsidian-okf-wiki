import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskGuard, isWithin } from "../../src/obsidian/diskGuard";
import { bundlePathErrors, VaultBundleSource, type VaultChange, type VaultPort } from "../../src/obsidian/vaultBundleSource";

/** An in-memory vault. Paths starting with "." are hidden from listFiles, as in Obsidian. */
class FakeVault implements VaultPort {
  configDir = ".obsidian";
  files = new Map<string, string>();
  unsafe = new Set<string>();
  private listeners: ((c: VaultChange) => void)[] = [];

  listFiles(): string[] {
    return [...this.files.keys()].filter((p) => !p.split("/").some((s) => s.startsWith(".")));
  }
  isFolder(path: string): boolean {
    return [...this.files.keys()].some((f) => f.startsWith(`${path}/`));
  }
  async readText(path: string): Promise<string> {
    const t = this.files.get(path);
    if (t === undefined) throw new Error(`missing ${path}`);
    return t;
  }
  async readHidden(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  isSafeOnDisk(path: string): boolean {
    return !this.unsafe.has(path);
  }
  onChange(listener: (c: VaultChange) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }
  emit(c: VaultChange): void {
    for (const l of this.listeners) l(c);
  }
  write(path: string, text: string): void {
    const kind = this.files.has(path) ? "modify" : "create";
    this.files.set(path, text);
    this.emit({ kind, path });
  }
}

const doc = (type: string, title = "T") => `---\ntype: ${type}\ntitle: ${title}\n---\n\nBody\n`;

async function settle(source: VaultBundleSource): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
  await source.flush();
}

describe("VaultBundleSource", () => {
  function setup() {
    const vault = new FakeVault();
    vault.files.set("Knowledge/concepts/a.md", doc("Note", "Alpha"));
    vault.files.set("Knowledge/references/raw/r.md", doc("Raw Source"));
    vault.files.set("Knowledge/data/table.csv", "a,b\n");
    vault.files.set("Knowledge/.okf.yaml", "raw_dirs: [references/raw]\n");
    vault.files.set("Personal/diary.md", "# private\n");
    const settings = [{ path: "Knowledge", enabled: true }];
    const source = new VaultBundleSource(vault, () => settings, { debounceMs: 1 });
    return { vault, source, settings };
  }

  it("loads enabled bundles with their policy and nothing outside them", async () => {
    const { source } = setup();
    expect(source.ready()).toBe(false);
    await source.reload();
    expect(source.ready()).toBe(true);
    const [b] = source.bundles();
    expect(b!.name).toBe("Knowledge");
    expect([...b!.model.concepts.keys()].sort()).toEqual(["concepts/a.md", "references/raw/r.md"]);
    expect(b!.model.files.get("data/table.csv")).toBe("");
    expect(b!.model.hasPolicyFile).toBe(true);
    expect([...b!.model.files.keys()].some((k) => k.includes("diary"))).toBe(false);
  });

  it("follows create, modify, rename and delete with a new model version", async () => {
    const { vault, source } = setup();
    await source.reload();
    const v1 = source.bundles()[0]!.version;
    vault.write("Knowledge/concepts/b.md", doc("Note", "Beta"));
    vault.write("Knowledge/concepts/a.md", doc("Note", "Alpha 2"));
    await settle(source);
    let m = source.bundles()[0]!;
    expect(m.version).toBeGreaterThan(v1);
    expect(m.model.concepts.get("concepts/b.md")?.title).toBe("Beta");
    expect(m.model.concepts.get("concepts/a.md")?.title).toBe("Alpha 2");

    vault.files.set("Knowledge/concepts/c.md", vault.files.get("Knowledge/concepts/b.md")!);
    vault.files.delete("Knowledge/concepts/b.md");
    vault.emit({ kind: "rename", path: "Knowledge/concepts/c.md", oldPath: "Knowledge/concepts/b.md" });
    vault.files.delete("Knowledge/concepts/a.md");
    vault.emit({ kind: "delete", path: "Knowledge/concepts/a.md" });
    await settle(source);
    m = source.bundles()[0]!;
    expect([...m.model.concepts.keys()].sort()).toEqual(["concepts/c.md", "references/raw/r.md"]);
  });

  it("moves files between bundles and out of bundles on rename", async () => {
    const { vault, source } = setup();
    await source.reload();
    vault.files.set("Personal/a.md", vault.files.get("Knowledge/concepts/a.md")!);
    vault.files.delete("Knowledge/concepts/a.md");
    vault.emit({ kind: "rename", path: "Personal/a.md", oldPath: "Knowledge/concepts/a.md" });
    await settle(source);
    expect(source.bundles()[0]!.model.concepts.has("concepts/a.md")).toBe(false);
  });

  it("re-reads the policy file on every rebuild", async () => {
    const { vault, source } = setup();
    await source.reload();
    vault.files.set("Knowledge/.okf.yaml", "raw_dirs: [data]\n");
    vault.write("Knowledge/concepts/a.md", doc("Note"));
    await settle(source);
    expect(source.bundles()[0]!.model.policy.raw_dirs).toEqual(["data"]);
  });

  it("skips files whose real location is unsafe", async () => {
    const { vault, source } = setup();
    vault.unsafe.add("Knowledge/concepts/a.md");
    const logged: string[] = [];
    const s = new VaultBundleSource(vault, () => [{ path: "Knowledge", enabled: true }], { log: (m) => logged.push(m) });
    await s.reload();
    expect(s.bundles()[0]!.model.concepts.has("concepts/a.md")).toBe(false);
    expect(logged.join()).toMatch(/real location/);
    void source;
  });

  it("loads in slices the first time and reuses the parse when reloading", async () => {
    const vault = new FakeVault();
    for (let i = 0; i < 20; i++) vault.files.set(`Knowledge/n${i}.md`, doc("Note", `N${i}`));
    let pauses = 0;
    const source = new VaultBundleSource(vault, () => [{ path: "Knowledge", enabled: true }], {
      debounceMs: 1,
      pause: async () => void pauses++,
    });
    // Every Date.now() call advances a whole slice, so the first load pauses after each file.
    const realNow = Date.now;
    let t = 0;
    Date.now = () => (t += 100);
    try {
      await source.reload();
    } finally {
      Date.now = realNow;
    }
    expect(pauses).toBe(20);
    const first = source.bundles()[0]!.model;
    await source.reload();
    const second = source.bundles()[0]!.model;
    expect(pauses).toBe(20);
    expect(second.concepts.get("n3.md")!.frontmatter).toBe(first.concepts.get("n3.md")!.frontmatter);
  });

  it("never lets a sliced first load that finishes late replace a newer model", async () => {
    const vault = new FakeVault();
    vault.files.set("Knowledge/a.md", doc("Note", "Old"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const source = new VaultBundleSource(vault, () => [{ path: "Knowledge", enabled: true }], { pause: () => gate });
    const realNow = Date.now;
    let t = 0;
    Date.now = () => (t += 100);
    let loading: Promise<void>;
    try {
      loading = source.reload();
      // While the first load waits at its pause, our own write lands and rebuilds synchronously.
      await new Promise((r) => setTimeout(r, 5));
      source.applyLocal("Knowledge", new Map([["a.md", doc("Note", "New")]]));
      release();
      await loading;
    } finally {
      Date.now = realNow;
    }
    expect(source.bundles()[0]!.model.concepts.get("a.md")!.title).toBe("New");
  });

  it("reads a non-markdown file on request, checking its real location again", async () => {
    const { vault, source } = setup();
    await source.reload();
    expect(source.bundles()[0]!.model.files.get("data/table.csv")).toBe("");
    expect(await source.readText("Knowledge", "data/table.csv")).toBe("a,b\n");
    vault.unsafe.add("Knowledge/data/table.csv");
    expect(await source.readText("Knowledge", "data/table.csv")).toBeNull();
    expect(await source.readText("Personal", "diary.md")).toBeNull();
  });

  it("drops bundles that were disabled", async () => {
    const { source, settings } = setup();
    await source.reload();
    settings[0]!.enabled = false;
    await source.reload();
    expect(source.bundles()).toEqual([]);
  });

  it("discovers unregistered bundles by .okf.yaml or okf_version", async () => {
    const { vault, source } = setup();
    vault.files.set("Team/KB/index.md", '---\nokf_version: "0.2"\n---\n\n# Subdirectories\n');
    vault.files.set("Team/KB/sub/index.md", "# Metric\n");
    vault.files.set("Other/index.md", "# Plain\n");
    vault.files.set("Policy/index.md", "# P\n");
    vault.files.set("Policy/.okf.yaml", "auto_index: true\n");
    expect(await source.discover()).toEqual(["Policy", "Team/KB"]);
  });
});

describe("bundlePathErrors", () => {
  const port = { configDir: ".obsidian", isFolder: (p: string) => ["Knowledge", "Knowledge/sub", "Work"].includes(p) };
  it("accepts a plain folder and rejects the rest", () => {
    expect(bundlePathErrors("Work", ["Knowledge"], port)).toEqual([]);
    expect(bundlePathErrors("/Work/", [], port)).toEqual([]);
    for (const bad of ["", "../x", "a\\b", ".obsidian", ".hidden/x", "Missing", "Knowledge"]) {
      expect(bundlePathErrors(bad, ["Knowledge"], port).length, bad).toBeGreaterThan(0);
    }
    expect(bundlePathErrors("Knowledge/sub", ["Knowledge"], port)[0]).toMatch(/nested/);
  });
});

describe("disk guard", () => {
  it("refuses links that leave the vault or enter the config folder", () => {
    const root = mkdtempSync(join(tmpdir(), "okf-guard-"));
    try {
      const vault = join(root, "vault");
      const outside = join(root, "outside");
      mkdirSync(join(vault, "Knowledge"), { recursive: true });
      mkdirSync(join(vault, ".obsidian"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(vault, "Knowledge", "a.md"), "x");
      writeFileSync(join(vault, ".obsidian", "secret.json"), "x");
      writeFileSync(join(outside, "b.md"), "x");
      // Junctions need no special privileges on Windows; "dir" links elsewhere.
      const kind = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(outside, join(vault, "Knowledge", "out"), kind);
      symlinkSync(join(vault, ".obsidian"), join(vault, "Knowledge", "cfg"), kind);
      const guard = createDiskGuard(vault, ".obsidian");
      expect(guard("Knowledge/a.md")).toBe(true);
      expect(guard("Knowledge/out/b.md")).toBe(false);
      expect(guard("Knowledge/cfg/secret.json")).toBe(false);
      expect(guard("Knowledge/missing.md")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compares containment by path segments", () => {
    const v = join(tmpdir(), "v");
    expect(isWithin(join(v, "Knowledge", "a"), v)).toBe(true);
    expect(isWithin(v, v)).toBe(true);
    expect(isWithin(join(tmpdir(), "vault2", "a"), v)).toBe(false);
  });
});
