import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundleDir, main } from "../../src/cli/okf";
import { FIXTURE_ROOT } from "../helpers";

const out: string[] = [];
vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
vi.spyOn(process.stderr, "write").mockImplementation((s) => (out.push(String(s)), true));
afterEach(() => void (out.length = 0));

describe("okf CLI", () => {
  it("lint exits 0 on a conformant sample and reports JSON", () => {
    expect(main(["lint", join(FIXTURE_ROOT, "ga4"), "--json"])).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(report.counts.error).toBe(0);
  });

  it("lint --strict fails on warnings", () => {
    expect(main(["lint", join(FIXTURE_ROOT, "acme_retail"), "--strict"])).toBe(1);
  });

  it("index --write converges and keeps CRLF files CRLF", () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-cli-"));
    try {
      cpSync(join(FIXTURE_ROOT, "stackoverflow"), dir, { recursive: true });
      const tablesIndex = join(dir, "tables", "index.md");
      writeFileSync(tablesIndex, readFileSync(tablesIndex, "utf8").replace(/\n/g, "\r\n"));
      expect(main(["index", dir])).toBe(1);
      expect(main(["index", dir, "--write"])).toBe(0);
      expect(main(["index", dir])).toBe(0);
      expect(readFileSync(tablesIndex, "utf8")).toMatch(/\r\n/);
      expect(readFileSync(tablesIndex, "utf8").replace(/\r\n/g, "")).not.toMatch(/\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips hidden directories but reads the policy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-cli-"));
    try {
      writeFileSync(join(dir, ".okf.yaml"), "raw_dirs: [raw]\n");
      writeFileSync(join(dir, "a.md"), "---\ntype: Note\n---\n");
      cpSync(join(FIXTURE_ROOT, "ga4"), join(dir, ".trash"), { recursive: true });
      expect([...loadBundleDir(dir).keys()].sort()).toEqual([".okf.yaml", "a.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad usage", () => {
    expect(main([])).toBe(2);
    expect(main(["lint", join(FIXTURE_ROOT, "nope")])).toBe(2);
    expect(main(["frobnicate", FIXTURE_ROOT])).toBe(2);
  });
});
