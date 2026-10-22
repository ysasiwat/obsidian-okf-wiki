// DESIGN.md §12 item 2: the OKF reference implementation (Python) must read what this
// plugin writes and reach the same conclusions: every concept parses and validates, with
// the same trust tier and staleness as okf-core. Skipped when Python or PyYAML is missing.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isStale, trustTier } from "../../src/core/trust";
import { etagOf } from "../../src/core/write";
import { WriteService, type Writer } from "../../src/service/writeService";
import { loadFixtureBundle } from "../helpers";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../helpers-service";

const NOW = new Date("2026-10-19T08:00:00Z");
// -E ignores PYTHON* environment variables and -P keeps the script's folder off sys.path;
// user site-packages stay available, which is where PyYAML is often installed.
const PY_FLAGS = ["-E", "-P"];
const python = ["python3", "python"].find((cmd) => spawnSync(cmd, [...PY_FLAGS, "-c", "import yaml"], { encoding: "utf8" }).status === 0);

describe.skipIf(!python)("cross-implementation check with the OKF reference parser", () => {
  it("agrees on validity, trust tier and staleness for a bundle written through the plugin", async () => {
    const provider = new MemoryProvider().set("K", loadFixtureBundle("acme_retail"));
    const writes = new WriteService(provider, new MemoryFilePort(provider), new MemorySnapshots(), new MemoryAudit(), { now: () => NOW, perMinute: 10_000, perDay: 10_000 });
    const agent: Writer = { kind: "token", principal: principal({ tokenName: "claude-code", scopes: new Set(["read", "write", "publish"]) }), actor: "claude-code/opus-5.5" };
    const files = () => provider.files.get("K")!;

    // A spread of writes: create (draft), update (body ops, sources, tags), raw ingest,
    // deprecate, publish and a move, on top of the existing sample bundle.
    await writes.write(agent, "K", { kind: "create", conceptId: "concepts/net-revenue", frontmatter: { type: "Metric", title: "Net revenue", description: "Revenue after returns.", tags: ["finance"], sources: [{ id: "rev", resource: "metrics/revenue.md", title: "Revenue" }], stale_after: "2026-01-01T00:00:00Z" }, body: "Net revenue subtracts returns from [[revenue]].[^rev]\n\n[^rev]: Revenue\n", reason: "New metric." }, "okf_create");
    const rev = files().get("metrics/revenue.md")!;
    await writes.write(agent, "K", { kind: "update", conceptId: "metrics/revenue", ifMatch: etagOf(rev), reason: "Link net revenue.", patch: { tags_add: ["kpi"] }, bodyOps: [{ op: "append", content: "See [[net-revenue]]." }] }, "okf_update");
    await writes.write(agent, "K", { kind: "ingest_raw", slug: "th-finance-notes", title: "Finance notes", description: "Original finance notes in Thai.", language: "th", resource: "https://example.com/notes", body: "บันทึกการเงิน รายได้สุทธิ\n" }, "okf_ingest_raw");
    await writes.write(agent, "K", { kind: "deprecate", conceptId: "metrics/gross-margin-legacy", reason: "Already retired.", replacedBy: "metrics/gross-margin" }, "okf_deprecate");
    const net = files().get("concepts/net-revenue.md")!;
    await writes.write(agent, "K", { kind: "publish", conceptId: "concepts/net-revenue", ifMatch: etagOf(net), reason: "Reviewed by the finance process." }, "okf_publish");
    const net2 = files().get("concepts/net-revenue.md")!;
    await writes.move(agent, "K", { from: "concepts/net-revenue", to: "metrics/net-revenue", ifMatch: etagOf(net2), reason: "Belongs with metrics." });

    const dir = mkdtempSync(join(tmpdir(), "okf-cross-"));
    try {
      for (const [p, t] of files()) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t, "utf8");
      }
      const run = spawnSync(python!, [...PY_FLAGS, join(__dirname, "reference_check.py"), dir, NOW.toISOString()], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const theirs = JSON.parse(run.stdout) as Record<string, { valid: boolean; error: string | null; tier: string; stale: boolean }>;
      const model = provider.bundles()[0]!.model;
      const ours = Object.fromEntries([...model.concepts.values()].map((c) => [c.path, { valid: true, error: null, tier: trustTier(c.frontmatter), stale: isStale(c.frontmatter, NOW) }]));
      expect(theirs).toEqual(ours);
      expect(Object.keys(theirs)).toEqual(expect.arrayContaining(["metrics/net-revenue.md", "references/raw/th-finance-notes.md"]));
      expect(theirs["metrics/net-revenue.md"]!.stale).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000); // Spawns Python; the default 5 s is too tight on a busy machine.
});
