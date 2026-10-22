import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { HumanInputTracker } from "../../src/obsidian/humanInput";
import { VaultFilePort } from "../../src/obsidian/vaultFilePort";
import { WriteConflict } from "../../src/service/types";

// The obsidian package ships types only; the port needs just these classes at runtime.
vi.mock("obsidian", () => ({ MarkdownView: class {}, TFile: class {}, TFolder: class {} }));
const { TFile, TFolder } = await import("obsidian");

/** A vault whose cache lists `cached` folders, while only `onDisk` folders really exist. */
function fakeApp(cached: string[], onDisk: string[]) {
  const disk = new Set(onDisk);
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const app = {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      getAbstractFileByPath: (p: string) =>
        files.has(p) ? Object.assign(new TFile(), { path: p }) : cached.includes(p) ? new TFolder() : null,
      createFolder: async (p: string) => { cached.push(p); disk.add(p); },
      create: async (p: string, text: string) => {
        const dir = p.slice(0, p.lastIndexOf("/"));
        if (!disk.has(dir)) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
        files.set(p, text);
      },
      rename: async (f: { path: string }, to: string) => {
        const dir = to.slice(0, to.lastIndexOf("/"));
        if (!disk.has(dir) || !files.has(f.path)) throw new Error(`ENOENT: no such file or directory, rename '${f.path}' -> '${to}'`);
        files.set(to, files.get(f.path)!);
        files.delete(f.path);
      },
      adapter: {
        exists: async (p: string) => disk.has(p),
        mkdir: async (p: string) => { mkdirs.push(p); disk.add(p); },
      },
    },
  };
  return { app: app as unknown as App, files, mkdirs };
}

describe("VaultFilePort.write (create)", () => {
  it("recovers when the cache lists a folder that is gone on disk", async () => {
    const { app, files, mkdirs } = fakeApp(["acme", "acme/live-test"], ["acme"]);
    await new VaultFilePort(app, new HumanInputTracker()).write("acme", "live-test/draft-one.md", "x", null);
    expect(mkdirs).toEqual(["acme/live-test"]);
    expect(files.get("acme/live-test/draft-one.md")).toBe("x");
  });

  it("still rejects a create over an existing file", async () => {
    const { app, files } = fakeApp(["acme"], ["acme"]);
    files.set("acme/a.md", "old");
    const port = new VaultFilePort(app, new HumanInputTracker());
    await expect(port.write("acme", "a.md", "new", null)).rejects.toBeInstanceOf(WriteConflict);
    expect(files.get("acme/a.md")).toBe("old");
  });

  it("does not retry other errors", async () => {
    const { app } = fakeApp(["acme"], ["acme"]);
    const create = vi.fn(async () => { throw new Error("EACCES: permission denied"); });
    (app.vault as unknown as { create: typeof create }).create = create;
    await expect(new VaultFilePort(app, new HumanInputTracker()).write("acme", "a.md", "x", null)).rejects.toThrow("EACCES");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the folder exists, as the ENOENT has another cause", async () => {
    const { app, mkdirs } = fakeApp(["acme"], ["acme"]);
    const create = vi.fn(async () => { throw new Error("ENOENT: no such file or directory"); });
    (app.vault as unknown as { create: typeof create }).create = create;
    await expect(new VaultFilePort(app, new HumanInputTracker()).write("acme", "a.md", "x", null)).rejects.toThrow("ENOENT");
    expect(create).toHaveBeenCalledTimes(1);
    expect(mkdirs).toEqual([]);
  });
});

describe("VaultFilePort.rename", () => {
  it("recovers when the cache lists the target folder that is gone on disk", async () => {
    const { app, files, mkdirs } = fakeApp(["acme", "acme/moved"], ["acme"]);
    files.set("acme/a.md", "x");
    await new VaultFilePort(app, new HumanInputTracker()).rename("acme", "a.md", "moved/a.md");
    expect(mkdirs).toEqual(["acme/moved"]);
    expect([...files.keys()]).toEqual(["acme/moved/a.md"]);
  });

  it("rethrows when the source file is what is missing on disk", async () => {
    const { app, files, mkdirs } = fakeApp(["acme", "acme/moved"], ["acme", "acme/moved"]);
    files.set("acme/a.md", "x");
    const rename = vi.fn(async () => { throw new Error("ENOENT: no such file or directory, rename"); });
    (app.vault as unknown as { rename: typeof rename }).rename = rename;
    await expect(new VaultFilePort(app, new HumanInputTracker()).rename("acme", "a.md", "moved/a.md")).rejects.toThrow("ENOENT");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(mkdirs).toEqual([]);
  });
});
