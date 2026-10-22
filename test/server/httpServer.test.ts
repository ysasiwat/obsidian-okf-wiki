// The HTTP endpoint over real sockets: both MCP protocol legs, the security guards, and
// the token/session rules (DESIGN.md §8, security suite in §12).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { KnowledgeService } from "../../src/service/knowledgeService";
import { AUTH_FAILURE_LIMIT, AuthThrottle, MAX_BODY_BYTES, MAX_SESSIONS, OkfHttpServer } from "../../src/server/httpServer";
import { createTokenRecord, hashToken, TokenStore, tokenNameErrors, type TokenRecord } from "../../src/server/tokens";
import { fixtureProvider } from "../helpers-service";

const service = new KnowledgeService(fixtureProvider("acme_retail", "ga4"));
const full = createTokenRecord({ name: "claude-code" });
const scoped = createTokenRecord({ name: "metrics-only", bundles: ["acme_retail"], pathPrefixes: ["metrics"] });
const records: TokenRecord[] = [full.record, scoped.record];
const used: string[] = [];
const server = new OkfHttpServer({ service, tokens: new TokenStore(() => records, (r) => used.push(r.name)), version: "test" });
let base: string;

beforeAll(async () => {
  await server.start(0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop();
});

function post(path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function client(token: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

const initialize = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "0" } },
});

describe("MCP over HTTP", () => {
  it("serves the current SDK client end to end", async () => {
    const c = await client(full.token);
    const r = await c.callTool({ name: "okf_search", arguments: { bundle: "acme_retail", query: "revenue" } });
    expect((r.structuredContent as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    await c.close();
    expect(used).toContain("claude-code");
  });

  it("serves a legacy sessionful handshake and binds the session to its token", async () => {
    const init = await post("/mcp/", initialize, { Authorization: `Bearer ${full.token}` });
    expect(init.status).toBe(200);
    const sid = init.headers["mcp-session-id"] as string;
    expect(sid).toBeTruthy();
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const headers = { "mcp-session-id": sid, "mcp-protocol-version": "2025-11-25" };
    const ok = await post("/mcp/", list, { ...headers, Authorization: `Bearer ${full.token}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatch(/okf_read/);
    const hijack = await post("/mcp/", list, { ...headers, Authorization: `Bearer ${scoped.token}` });
    expect(hijack.status).toBe(404);
  });

  it("applies the token's path scope", async () => {
    const c = await client(scoped.token);
    const r = await c.callTool({ name: "okf_read", arguments: { concept_id: "policies/margin-standard" } });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it("never gives one token's concurrent requests another token's principal", async () => {
    const [wide, narrow] = await Promise.all([client(full.token), client(scoped.token)]);
    const read = (c: Client) => c.callTool({ name: "okf_read", arguments: { bundle: "acme_retail", concept_id: "policies/margin-standard" } });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? read(narrow) : read(wide)).then((r) => [i % 2, r.isError] as const)));
    for (const [isNarrow, isError] of results) expect(Boolean(isError)).toBe(isNarrow === 1);
    await Promise.all([wide.close(), narrow.close()]);
  });
});

describe("guards", () => {
  it("requires a bearer token", async () => {
    const r = await post("/mcp/", initialize);
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("refuses requests that carry an Origin header, and preflights", async () => {
    expect((await post("/mcp/", initialize, { Origin: "http://localhost:3000", Authorization: `Bearer ${full.token}` })).status).toBe(403);
    const pre = await new Promise<number>((resolve) => {
      http.request(`${base}/mcp/`, { method: "OPTIONS" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      }).end();
    });
    expect(pre).toBe(403);
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    expect((await post("/mcp/", initialize, { Host: "evil.example", Authorization: `Bearer ${full.token}` })).status).toBe(403);
  });

  it("limits body size and rejects malformed JSON", async () => {
    const auth = { Authorization: `Bearer ${full.token}` };
    expect((await post("/mcp/", "x".repeat(MAX_BODY_BYTES + 1), auth)).status).toBe(413);
    expect((await post("/mcp/", "{not json", auth)).status).toBe(400);
  });

  it("serves only /mcp and /health", async () => {
    expect((await post("/vault/x.md", "{}", { Authorization: `Bearer ${full.token}` })).status).toBe(404);
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ ok: true });
  });
});

describe("failed-credential throttle", () => {
  it("locks out after the limit but never delays a correct token", () => {
    let t = 0;
    const th = new AuthThrottle(() => t);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) th.fail("a");
    expect(th.retryAfterSeconds("a")).toBe(60);
    expect(th.retryAfterSeconds("b")).toBe(0);
    t = 60_001;
    expect(th.retryAfterSeconds("a")).toBe(0);
  });

  it("answers 429 to wrong tokens from a throttled address while the right token works", async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) await post("/mcp/", initialize, { Authorization: "Bearer wrong" });
    const blocked = await post("/mcp/", initialize, { Authorization: "Bearer wrong" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
    expect((await post("/mcp/", initialize, { Authorization: `Bearer ${full.token}` })).status).toBe(200);
  });
});

describe("tokens", () => {
  it("stores only a hash and authenticates by it", () => {
    expect(full.record.hash).toBe(hashToken(full.token));
    expect(JSON.stringify(full.record)).not.toContain(full.token);
    const store = new TokenStore(() => records);
    expect(store.authenticate(full.token)?.name).toBe("claude-code");
    expect(store.authenticate(`${full.token}x`)).toBeNull();
  });

  it("validates names and scopes", () => {
    expect(tokenNameErrors("Claude Code")).not.toEqual([]);
    expect(() => createTokenRecord({ name: "x", scopes: ["root" as never] })).toThrow(/scope/);
  });

  it("stops authenticating a revoked token immediately", () => {
    const list = [createTokenRecord({ name: "temp" })];
    const store = new TokenStore(() => list.map((x) => x.record));
    expect(store.authenticate(list[0]!.token)).not.toBeNull();
    list.pop();
    expect(store.authenticate(createTokenRecord({ name: "temp" }).token)).toBeNull();
  });
});

describe("legacy session table", () => {
  it("evicts the session idle the longest instead of refusing new clients when full", async () => {
    const s = new OkfHttpServer({ service, tokens: new TokenStore(() => records), version: "test" });
    await s.start(0);
    const url = `http://127.0.0.1:${s.port}/mcp/`;
    const headers = (id?: string) => ({ Authorization: `Bearer ${full.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(id ? { "Mcp-Session-Id": id, "Mcp-Protocol-Version": "2025-11-25" } : {}) });
    const open = async () => {
      const r = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "leaky", version: "0" } } }) });
      await r.body?.cancel();
      expect(r.status).toBe(200);
      return r.headers.get("mcp-session-id")!;
    };
    const ping = async (id: string) => {
      const r = await fetch(url, { method: "POST", headers: headers(id), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
      await r.body?.cancel();
      return r.status;
    };
    const ids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) ids.push(await open());
    expect(await ping(ids[0]!)).toBe(200); // the oldest is used again, so ids[1] is now idle the longest
    await open();
    expect(await ping(ids[1]!)).toBe(404);
    expect(await ping(ids[0]!)).toBe(200);
    await s.stop();
  }, 60_000);
});

describe("start and stop on a reused port", () => {
  const make = () => new OkfHttpServer({ service, tokens: new TokenStore(() => records), version: "test" });
  const health = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`)).status;

  it("comes up on every one of ten quick reloads, as when Obsidian does not await onunload", async () => {
    let current = make();
    await current.start(0);
    const port = current.port!;
    for (let i = 0; i < 10; i++) {
      const next = make();
      const starting = next.start(port);
      // The old instance lets go a moment later, as when it first flushes state to disk.
      const old = current;
      setTimeout(() => void old.stop(), 300);
      await starting;
      expect(await health(port)).toBe(200);
      current = next;
    }
    await current.stop();
  }, 30_000);

  it("keeps serving after a server 'error', and reports a close it did not ask for", async () => {
    let closed = 0;
    const s = new OkfHttpServer({ service, tokens: new TokenStore(() => records), version: "test", log: () => {}, onUnexpectedClose: () => closed++ });
    await s.start(0);
    const port = s.port!;
    const inner = (s as unknown as { server: http.Server }).server;
    // With no 'error' listener this would throw out of emit().
    expect(() => inner.emit("error", Object.assign(new Error("accept failed"), { code: "ECONNRESET" }))).not.toThrow();
    expect(await health(port)).toBe(200);
    await new Promise<void>((r) => inner.close(() => r()));
    expect(closed).toBe(1);
    expect(s.port).toBeNull();
    await s.stop();

    const normal = new OkfHttpServer({ service, tokens: new TokenStore(() => records), version: "test", onUnexpectedClose: () => closed++ });
    await normal.start(0);
    await normal.stop();
    expect(closed).toBe(1);
  });

  it("gives up cleanly when stopped while waiting for the port", async () => {
    const holder = make();
    await holder.start(0);
    const port = holder.port!;
    const waiting = make();
    const starting = waiting.start(port);
    await new Promise((r) => setTimeout(r, 100));
    await waiting.stop();
    await holder.stop();
    await expect(starting).rejects.toThrow(/stopped/);
    const after = make();
    await after.start(port);
    expect(await health(port)).toBe(200);
    await after.stop();
  }, 30_000);
});
