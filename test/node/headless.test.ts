import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon, findConfigDir } from "../../src/cli/serve";
import { etagOf } from "../../src/core/write";
import { LOCK_FILE, LOCK_STALE_MS, lockHeld, readDaemon, removeLock, writeLock } from "../../src/node/handoff";
import { NodeFilePort, NodeVault, nodeVaultPort } from "../../src/node/ports";
import { createTokenRecord } from "../../src/server/tokens";
import { WriteConflict } from "../../src/service/types";

const dirs: string[] = [];
function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "okf-headless-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".obsidian", "plugins", "okf-wiki"), { recursive: true });
  mkdirSync(join(dir, "kb"));
  writeFileSync(join(dir, "kb", "a.md"), "---\ntype: concept\n---\nA\n");
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Node ports", () => {
  it("lists vault files without dot-folders", () => {
    const v = tempVault();
    mkdirSync(join(v, ".trash"));
    writeFileSync(join(v, ".trash", "x.md"), "x");
    expect(nodeVaultPort(new NodeVault(v, ".obsidian")).listFiles().sort()).toEqual(["kb/a.md"]);
  });

  it("writes against the etag and refuses stale or clashing writes", async () => {
    const v = tempVault();
    const port = new NodeFilePort(new NodeVault(v, ".obsidian"));
    const text = (await port.read("kb", "a.md"))!;
    await port.write("kb", "a.md", "B\n", etagOf(text));
    expect(readFileSync(join(v, "kb", "a.md"), "utf8")).toBe("B\n");
    await expect(port.write("kb", "a.md", "C\n", etagOf(text))).rejects.toBeInstanceOf(WriteConflict);
    await expect(port.write("kb", "a.md", "C\n", null)).rejects.toBeInstanceOf(WriteConflict);
    await port.write("kb", "new/b.md", "N\n", null);
    expect(readFileSync(join(v, "kb", "new", "b.md"), "utf8")).toBe("N\n");
  });

  it("moves deleted files to the vault's .trash", async () => {
    const v = tempVault();
    await new NodeFilePort(new NodeVault(v, ".obsidian")).trash("kb", "a.md");
    expect(existsSync(join(v, "kb", "a.md"))).toBe(false);
    expect(existsSync(join(v, ".trash", "a.md"))).toBe(true);
  });
});

describe("hand-over lock", () => {
  it("is held only while fresh and only removed by the instance that wrote it", () => {
    const state = tempVault();
    writeLock(state, "1", "one");
    expect(lockHeld(state)).toBe(true);
    expect(lockHeld(state, Date.now() + LOCK_STALE_MS + 1)).toBe(false);
    removeLock(state, "two");
    expect(existsSync(join(state, LOCK_FILE))).toBe(true);
    removeLock(state, "one");
    expect(lockHeld(state)).toBe(false);
  });
});

describe("Daemon", () => {
  it("serves, releases to a loaded plugin and serves again", async () => {
    const v = tempVault();
    const { record } = createTokenRecord({ name: "reader" });
    const port = 27_190 + Math.floor(Math.random() * 9);
    writeFileSync(join(v, ".obsidian", "plugins", "okf-wiki", "data.json"), JSON.stringify({ port, bundles: [{ path: "kb" }], tokens: [record] }));
    const daemon = new Daemon({ vault: v, configDir: ".obsidian" }, () => {});
    try {
      await daemon.tick();
      expect(daemon.serving).toBe(true);
      expect(readDaemon(daemon.stateAbs)).toMatchObject({ state: "serving", writes: false });
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBeLessThan(500);

      writeLock(daemon.stateAbs, "test", "plugin");
      await daemon.tick();
      expect(daemon.serving).toBe(false);
      expect(readDaemon(daemon.stateAbs)?.state).toBe("released");
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

      removeLock(daemon.stateAbs, "plugin");
      await daemon.tick();
      expect(daemon.serving).toBe(true);
    } finally {
      await daemon.release();
    }
  });

  it("stays idle when serving while Obsidian is closed is turned off", async () => {
    const v = tempVault();
    const { record } = createTokenRecord({ name: "reader" });
    writeFileSync(join(v, ".obsidian", "plugins", "okf-wiki", "data.json"), JSON.stringify({ bundles: [{ path: "kb" }], tokens: [record], headlessEnabled: false }));
    const daemon = new Daemon({ vault: v, configDir: ".obsidian" }, () => {});
    await daemon.tick();
    expect(daemon.serving).toBe(false);
    expect(readDaemon(daemon.stateAbs)?.error).toMatch(/Serve while Obsidian is closed/);
  });

  it("stays idle when the plugin has no tokens", async () => {
    const v = tempVault();
    const daemon = new Daemon({ vault: v, configDir: ".obsidian" }, () => {});
    await daemon.tick();
    expect(daemon.serving).toBe(false);
    expect(readDaemon(daemon.stateAbs)?.error).toMatch(/no tokens/);
  });
});

describe("findConfigDir", () => {
  it("finds the one dot-folder that holds the plugin, else null", () => {
    const v = tempVault();
    expect(findConfigDir(v)).toBe(".obsidian");
    mkdirSync(join(v, ".config2", "plugins", "okf-wiki"), { recursive: true });
    expect(findConfigDir(v)).toBeNull();
    rmSync(join(v, ".obsidian"), { recursive: true });
    expect(findConfigDir(v)).toBe(".config2");
  });
});
