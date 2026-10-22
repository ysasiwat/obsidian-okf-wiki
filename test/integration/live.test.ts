// Checks against the plugin running inside Obsidian. Skipped unless OKF_WIKI_TOKEN is
// set. Expects a bundle named by OKF_WIKI_BUNDLE (default "acme_retail") holding the
// OKF acme_retail sample; OKF_WIKI_PORT defaults to 27150.
//
//   OKF_WIKI_TOKEN=okf_... npx vitest run test/integration

import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const token = process.env["OKF_WIKI_TOKEN"];
const bundle = process.env["OKF_WIKI_BUNDLE"] ?? "acme_retail";
const base = `http://127.0.0.1:${process.env["OKF_WIKI_PORT"] ?? "27150"}`;

// Real Obsidian on a synced vault: one write can take about a second, so the 5 s default is too tight.
describe.skipIf(!token)("live plugin", { timeout: 30_000 }, () => {
  const connect = async () => {
    const c = new Client({ name: "okf-live-test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    return r.structuredContent as Record<string, any>;
  };

  it("answers /health without a token and refuses requests without one", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/mcp/`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/mcp/`, { method: "POST", body: "{}", headers: { Authorization: "Bearer okf_wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/mcp/`, { method: "POST", body: "{}", headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" } })).status).toBe(403);
  });

  it("serves the vault bundle over the 2026-07-28 client", async () => {
    const c = await connect();
    const bundles = await call(c, "okf_bundles", {});
    expect(bundles["ready"]).toBe(true);
    const b = bundles["bundles"].find((x: { name: string }) => x.name === bundle);
    expect(b, `bundle ${bundle} not served; got ${JSON.stringify(bundles["bundles"].map((x: { name: string }) => x.name))}`).toBeDefined();
    expect(b.concepts).toBe(9);
    const hits = await call(c, "okf_search", { bundle, query: "gross margin" });
    expect(hits["hits"][0].concept_id).toMatch(/gross-margin/);
    const read = await call(c, "okf_read", { bundle, concept_id: "metrics/gross-margin", view: "outline" });
    expect(read["trust_tier"]).toBe("human-reviewed");
    const browse = await call(c, "okf_browse", { bundle, dir: "attesters" });
    expect(browse["files"]).toEqual(["attesters/sql_equality.py"]);
    await c.close();
  });

  it("serves a legacy sessionful handshake", async () => {
    const r = await fetch(`${base}/mcp/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "0" } } }),
    });
    expect(r.status).toBe(200);
    const id = r.headers.get("mcp-session-id");
    expect(id).toBeTruthy();
    await r.body?.cancel();
    // Close it, so repeated runs do not fill the server's session table.
    await fetch(`${base}/mcp/`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": id!, "Mcp-Protocol-Version": "2025-11-25" } });
  });
});
