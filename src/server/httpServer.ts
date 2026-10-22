// The HTTP endpoint (DESIGN.md §8): plain node:http on loopback serving MCP at /mcp.
//
// Request order: Host and Origin guards (DNS rebinding), no CORS, bearer token, failed-
// credential throttle, body size limit, then the MCP SDK. The 2026-07-28 revision is
// served statelessly; older revisions get sessions bound to the token that opened them.
// The approach follows obsidian-local-rest-api src/mcpHandler.ts; no code is taken from it.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { createMcpHandler, isLegacyRequest, type AuthInfo } from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  originValidation,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import { buildMcpServer } from "../mcp/buildServer";
import type { KnowledgeService } from "../service/knowledgeService";
import type { WriteService } from "../service/writeService";
import type { Principal } from "../service/types";
import { toPrincipal, type TokenRecord, type TokenStore } from "./tokens";

export const DEFAULT_PORT = 27150;
export const LOOPBACK = "127.0.0.1";
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_SESSIONS = 64;
export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Listen attempts while the port is still held, e.g. by the instance a reload replaces. */
export const START_ATTEMPTS = 12;
export const START_RETRY_MS = 250;

export interface ServerOptions {
  service: KnowledgeService;
  /** Enables write tools for tokens with the write scope. */
  writes?: WriteService;
  tokens: TokenStore;
  version: string;
  /** Origin hostnames allowed to call; empty refuses every request that carries Origin. */
  allowedOrigins?: string[];
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
  now?: () => number;
  /** The listener closed without stop(), so the owner can show that the server is down. */
  onUnexpectedClose?: () => void;
}

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  tokenId: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Failed-credential counter per remote address; correct credentials are never slowed. */
export class AuthThrottle {
  private failures = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  retryAfterSeconds(address: string): number {
    const times = this.recent(address);
    if (times.length < AUTH_FAILURE_LIMIT) return 0;
    return Math.max(1, Math.ceil((times[0]! + AUTH_FAILURE_WINDOW_MS - this.now()) / 1000));
  }

  fail(address: string): void {
    this.failures.set(address, [...this.recent(address), this.now()]);
  }

  private recent(address: string): number[] {
    const cutoff = this.now() - AUTH_FAILURE_WINDOW_MS;
    const times = (this.failures.get(address) ?? []).filter((t) => t > cutoff);
    if (times.length === 0) this.failures.delete(address);
    else this.failures.set(address, times);
    return times;
  }
}

export class OkfHttpServer {
  private server: http.Server | null = null;
  private stopped = false;
  /**
   * Principals of in-flight stateless requests, keyed by a one-off id passed to the SDK as
   * authInfo.clientId. Not AsyncLocalStorage: in Obsidian's renderer its promise hooks share V8 with
   * Chromium, and every plugin reload added another instance that was never disabled.
   */
  private readonly inFlight = new Map<string, Principal>();
  private readonly sessions = new Map<string, Session>();
  private readonly throttle: AuthThrottle;
  private readonly sessionless;
  private readonly sessionlessNode;
  private readonly hostOk = localhostHostValidation();
  private readonly originOk;

  constructor(private readonly options: ServerOptions) {
    this.throttle = new AuthThrottle(options.now);
    this.originOk = originValidation(options.allowedOrigins ?? []);
    const onerror = (e: Error) => this.log("error", "MCP handler error", e);
    this.sessionless = createMcpHandler((ctx) => this.build(this.principalFor(ctx.authInfo?.clientId)), { legacy: "reject", onerror });
    this.sessionlessNode = toNodeHandler(this.sessionless, { onerror });
  }

  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : null;
  }

  async start(port: number = DEFAULT_PORT, host: string = LOOPBACK): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log("error", "request failed", e);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 65_000;
    const listen = () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    // A plugin reload starts the new server before the old one has released the port
    // (Obsidian does not await onunload), so wait a little for it.
    for (let attempt = 1; ; attempt++) {
      try {
        await listen();
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EADDRINUSE" || attempt >= START_ATTEMPTS) throw e;
        server.close();
        await new Promise((r) => window.setTimeout(r, START_RETRY_MS));
        if (this.stopped) throw new Error("server stopped while waiting for the port");
      }
    }
    if (this.stopped) {
      // stop() ran while we waited: do not leave a listener nobody can close.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("server stopped while waiting for the port");
    }
    // An 'error' after listen with no listener is thrown, which in Obsidian could take the
    // listener down while the plugin still showed it running (live test, 2026-10-21).
    server.on("error", (e) => this.log("error", "server error", e));
    server.on("close", () => {
      if (this.server !== server) return; // stop() clears this.server before closing
      this.server = null;
      this.log("error", "server stopped unexpectedly");
      this.options.onUnexpectedClose?.();
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const server = this.server;
    this.server = null;
    await Promise.allSettled([this.sessionless.close(), ...[...this.sessions.values()].map((s) => s.transport.close())]);
    this.sessions.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Close sessions opened by a token that has been revoked or changed. */
  dropSessionsFor(tokenId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.tokenId === tokenId) {
        void s.transport.close();
        this.sessions.delete(id);
      }
    }
  }

  private build(principal: Principal) {
    return buildMcpServer(this.options.service, principal, {
      version: this.options.version,
      ...(this.options.writes ? { writes: this.options.writes } : {}),
      onError: (e) => this.log("error", "tool failed", e),
    });
  }

  private principalFor(key: string | undefined): Principal {
    const p = key === undefined ? undefined : this.inFlight.get(key);
    if (!p) throw new Error("no principal for this request");
    return p;
  }

  private log(level: "info" | "warn" | "error", message: string, error?: unknown): void {
    this.options.log?.(level, message, error);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostOk(req, res) || !this.originOk(req, res)) return;
    const path = (req.url ?? "/").split("?")[0]!;

    if (req.method === "OPTIONS") return json(res, 403, { error: "cross-origin requests are not served" });
    if (path === "/health" && req.method === "GET") return json(res, 200, { ok: true });
    if (path !== "/mcp" && path !== "/mcp/") return json(res, 404, { error: "not found" });

    const record = this.authenticate(req, res);
    if (!record) return;

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      throw e;
    }

    const principal = toPrincipal(record);
    if (await isLegacyRequest(await toWebRequest(req, body))) return this.handleSessionful(req, res, body, record, principal);
    const key = randomUUID();
    this.inFlight.set(key, principal);
    try {
      // The SDK hands req.auth to the factory as ctx.authInfo; it carries only the lookup key, never the token.
      (req as http.IncomingMessage & { auth?: AuthInfo }).auth = { token: "", clientId: key, scopes: [...principal.scopes] };
      await this.sessionlessNode(req, res, body);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private authenticate(req: http.IncomingMessage, res: http.ServerResponse): TokenRecord | null {
    const address = req.socket.remoteAddress ?? "unknown";
    const header = req.headers.authorization;
    const m = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    if (!m) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-okf-wiki"');
      json(res, 401, { error: "Authorization: Bearer <token> required. Create a token in the plugin settings." });
      return null;
    }
    const record = this.options.tokens.authenticate(m[1]!);
    if (record) return record;
    // Only wrong credentials are throttled; a correct token is never delayed.
    const wait = this.throttle.retryAfterSeconds(address);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      json(res, 429, { error: "too many failed authentication attempts" });
      return null;
    }
    this.throttle.fail(address);
    res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-okf-wiki", error="invalid_token"');
    json(res, 401, { error: "invalid token" });
    return null;
  }

  private async handleSessionful(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
    record: TokenRecord,
    principal: Principal,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const s = this.sessions.get(sessionId);
      // A session belongs to the token that opened it; any other token is told it does not exist.
      if (!s || s.tokenId !== record.id) return json(res, 404, { error: "session not found" });
      // Re-insert so the map's order is least recently used first.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, s);
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      // Clients that vanish without DELETE would otherwise fill the table and lock every client out
      // until a restart; close the session idle the longest instead.
      const [oldestId, oldest] = this.sessions.entries().next().value!;
      this.sessions.delete(oldestId);
      void oldest.transport.close();
    }
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        this.sessions.set(id, { transport, tokenId: record.id });
      },
      onsessionclosed: (id: string): void => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await this.build(principal).connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
