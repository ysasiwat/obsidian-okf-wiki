// Write path against the plugin running in Obsidian. Skipped unless OKF_WIKI_WRITE_TOKEN
// (a token with the write scope) is set. Works under <bundle>/live-test/ in the
// acme_retail sample; OKF_WIKI_VAULT lets it check files on disk.
//
//   OKF_WIKI_WRITE_TOKEN=okf_... OKF_WIKI_VAULT=/path/to/vault npx vitest run test/integration/liveWrites.test.ts

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const token = process.env["OKF_WIKI_WRITE_TOKEN"];
const vault = process.env["OKF_WIKI_VAULT"];
const bundle = process.env["OKF_WIKI_BUNDLE"] ?? "acme_retail";
const base = `http://127.0.0.1:${process.env["OKF_WIKI_PORT"] ?? "27150"}`;
const stamp = Date.now().toString(36);

// Real Obsidian on a synced vault: one write can take about a second, so the 5 s default is too tight.
describe.skipIf(!token)("live plugin: writes", { timeout: 30_000 }, () => {
  const connect = async () => {
    const c = new Client({ name: "okf-live-writes", version: "1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>, ok = true) => {
    const r = await c.callTool({ name, arguments: { bundle, ...args } });
    if (ok && r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
    return r;
  };
  const sc = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;
  const disk = (p: string) => (vault ? readFileSync(join(vault, bundle, p), "utf8") : null);

  it("create, update, move and deprecate end to end", async () => {
    const c = await connect();
    const id = `live-test/remote-sensing-${stamp}`;
    const created = sc(await call(c, "okf_create", {
      concept_id: id,
      frontmatter: { type: "Concept", title: "Remote sensing", description: "Observing Earth from a distance.", tags: ["eo"] },
      body: "Remote sensing relates to [[revenue]] only as a test link.\n",
      reason: "Live test.",
      actor_version: "live-test",
    }));
    expect(created).toMatchObject({ changed: true, status: "draft" });

    const read = sc(await call(c, "okf_read", { concept_id: id }));
    expect(read["frontmatter"]["generated"]["by"]).toMatch(/\/live-test$/);
    expect(read["body"]).toContain("[revenue](../metrics/revenue.md)");

    const updated = sc(await call(c, "okf_update", { concept_id: id, if_match: read["etag"], reason: "Add an example.", body_ops: [{ op: "append", content: "## Example\n\nFlood mapping." }] }));
    expect(updated["changed"]).toBe(true);

    const stale = await call(c, "okf_update", { concept_id: id, if_match: read["etag"], reason: "Stale.", tags_add: ["x"] }, false);
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toMatch(/conflict/);

    const moved = sc(await call(c, "okf_move", { from: id, to: `${id}-v2`, if_match: updated["etag"], reason: "Rename for the live test." }));
    expect(moved["concept_id"]).toBe(`${id}-v2`);

    const dep = sc(await call(c, "okf_deprecate", { concept_id: `${id}-v2`, reason: "Live test finished." }));
    expect(dep["status"]).toBe("deprecated");

    const thai = await call(c, "okf_create", { concept_id: `live-test/thai-${stamp}`, frontmatter: { type: "Concept" }, body: "ดาวเทียมสำรวจทรัพยากรถ่ายภาพพื้นที่น้ำท่วม\n" }, false);
    expect(JSON.stringify(thai.content)).toMatch(/\[policy\]/);

    if (vault) {
      expect(existsSync(join(vault, bundle, `${id}.md`))).toBe(false);
      expect(disk(`${id}-v2.md`)).toContain("status: deprecated");
      expect(disk("live-test/index.md")).toContain(`remote-sensing-${stamp}-v2.md`);
      const log = disk("log.md")!;
      for (const action of ["Creation", "Update", "Move", "Deprecation"]) expect(log).toContain(`**${action}**: [Remote sensing`);
    }
    await c.close();
  });

  it("ingests a Thai raw source once", async () => {
    const c = await connect();
    const args = { slug: `live-raw-${stamp}`, title: "Live raw source", description: "A Thai original for the live test.", language: "th", resource: "https://example.com/live", body: `ต้นฉบับภาษาไทย ${stamp}\n` };
    const first = sc(await call(c, "okf_ingest_raw", args));
    expect(first["concept_id"]).toBe(`references/raw/live-raw-${stamp}`);
    const again = sc(await call(c, "okf_ingest_raw", { ...args, slug: `live-raw-copy-${stamp}` }));
    expect(again).toMatchObject({ changed: false, duplicate_of: `references/raw/live-raw-${stamp}` });
    await c.close();
  });

  it("distills a raw source: language fill, table footnotes, review request, index scope (Phase 3, 4A)", async () => {
    const c = await connect();
    const untouched = ["tables/index.md", "metrics/index.md"].map((p) => [p, disk(p)] as const);
    const raw = sc(await call(c, "okf_ingest_raw", { slug: `live-memo-${stamp}`, title: "Live memo", description: "A Thai memo for the live test.", language: "th", resource: "https://example.com/memo", body: `บันทึก ${stamp}: คืนสินค้าได้ภายใน 45 วัน\n` }));
    const rawPath = `/${raw["path"]}`;
    const id = `live-test/returns-${stamp}`;
    const table = "| Customer | Window |\n|---|---|\n| Member | 45 days |\n";
    const body = (t: string) => `Members get a longer window.[^memo]\n\n${t}\n[^memo]: [Live memo](${rawPath})\n`;
    const warns = (r: Record<string, any>) => (r["warnings"] as string[]).some((w) => w.startsWith("[table-uncited]"));

    const created = sc(await call(c, "okf_create", { concept_id: id, frontmatter: { type: "Policy", title: "Live returns", description: "Live test.", sources: [{ id: "memo", resource: rawPath, title: "Live memo" }] }, body: body(table) }));
    expect(warns(created)).toBe(true);
    let read = sc(await call(c, "okf_read", { concept_id: id }));
    expect(read["frontmatter"]["sources"][0]["language"]).toBe("th");
    expect(read["trust_attested"]).toBe(true);

    const under = sc(await call(c, "okf_update", { concept_id: id, if_match: read["etag"], reason: "Cite the table.", body: body(`${table}\n[^memo]\n`) }));
    expect(warns(under)).toBe(true);
    const inside = sc(await call(c, "okf_update", { concept_id: id, if_match: under["etag"], reason: "Cite the table.", body: body(table.replace("45 days |", "45 days[^memo] |")) }));
    expect(warns(inside)).toBe(false);

    await call(c, "okf_request_review", { concept_id: id, note: "Live test: please check the window." });
    read = sc(await call(c, "okf_read", { concept_id: id, view: "frontmatter" }));
    expect(read["frontmatter"]["review_requested"]).toBeTruthy();

    if (vault) for (const [p, text] of untouched) expect(disk(p), `${p} must not be rewritten`).toBe(text);
    await c.close();
  });
});
