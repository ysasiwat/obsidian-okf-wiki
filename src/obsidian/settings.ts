// Plugin settings (data.json). Device-level only: which bundles this vault exposes, the
// server port, token hashes. Bundle policy lives in each bundle's .okf.yaml.

import { DEFAULT_PORT } from "../server/httpServer";
import type { TokenRecord } from "../server/tokens";
import type { AutoApproveSettings } from "../service/autoApprove";
import { SCOPES, type Scope } from "../service/types";
import type { BundleSetting } from "./vaultBundleSource";

export interface PluginSettings {
  serverEnabled: boolean;
  port: number;
  bundles: BundleSetting[];
  tokens: TokenRecord[];
  /** Origin hostnames allowed to call the server; empty refuses all browser origins. */
  allowedOrigins: string[];
  /** Discovered bundle folders the owner chose not to enable. */
  dismissedBundles: string[];
  /** Kill switch: refuse every agent write while true (DESIGN.md §6.7). */
  agentWritesPaused: boolean;
  writesPerMinute: number;
  writesPerDay: number;
  /** The owner's id for human: actors (approvals, recorded edits, reverts). */
  userId: string;
  /** Record a person's edits in `generated` (DESIGN.md §5). */
  stampHumanEdits: boolean;
  /** Approve clean writes of listed tokens as process:auto-approve (DESIGN.md §5.3). */
  autoApprove: AutoApproveSettings;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  serverEnabled: true,
  port: DEFAULT_PORT,
  bundles: [],
  tokens: [],
  allowedOrigins: [],
  dismissedBundles: [],
  agentWritesPaused: false,
  writesPerMinute: 30,
  writesPerDay: 500,
  userId: "",
  stampHumanEdits: true,
  autoApprove: { enabled: false, tokens: [], bundles: [] },
};

const isString = (v: unknown): v is string => typeof v === "string";
const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);

function sanitizeToken(v: unknown): TokenRecord | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (!isString(t["id"]) || !isString(t["name"]) || !isString(t["hash"]) || !/^[0-9a-f]{64}$/.test(t["hash"])) return null;
  const scopes = stringArray(t["scopes"]).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return {
    id: t["id"],
    name: t["name"],
    kind: t["kind"] === "process" ? "process" : "agent",
    scopes,
    bundles: t["bundles"] === "*" ? "*" : stringArray(t["bundles"]),
    pathPrefixes: stringArray(t["pathPrefixes"]),
    hash: t["hash"],
    createdAt: isString(t["createdAt"]) ? t["createdAt"] : new Date(0).toISOString(),
    ...(isString(t["lastUsedAt"]) ? { lastUsedAt: t["lastUsedAt"] } : {}),
  };
}

/** Settings from whatever loadData() returned, with anything malformed replaced by defaults. */
export function sanitizeSettings(raw: unknown): PluginSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const port = Number(o["port"]);
  return {
    serverEnabled: typeof o["serverEnabled"] === "boolean" ? o["serverEnabled"] : DEFAULT_SETTINGS.serverEnabled,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.port,
    bundles: (Array.isArray(o["bundles"]) ? o["bundles"] : [])
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && isString((b as Record<string, unknown>)["path"]))
      .map((b) => ({ path: String(b["path"]), enabled: b["enabled"] !== false })),
    tokens: (Array.isArray(o["tokens"]) ? o["tokens"] : []).map(sanitizeToken).filter((t): t is TokenRecord => t !== null),
    allowedOrigins: stringArray(o["allowedOrigins"]),
    dismissedBundles: stringArray(o["dismissedBundles"]),
    agentWritesPaused: o["agentWritesPaused"] === true,
    writesPerMinute: positiveInt(o["writesPerMinute"], DEFAULT_SETTINGS.writesPerMinute, 1000),
    writesPerDay: positiveInt(o["writesPerDay"], DEFAULT_SETTINGS.writesPerDay, 100_000),
    userId: isString(o["userId"]) && USER_ID.test(o["userId"]) ? o["userId"] : "",
    stampHumanEdits: o["stampHumanEdits"] !== false,
    autoApprove: sanitizeAutoApprove(o["autoApprove"]),
  };
}

function sanitizeAutoApprove(v: unknown): AutoApproveSettings {
  const a = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { enabled: a["enabled"] === true, tokens: stringArray(a["tokens"]), bundles: stringArray(a["bundles"]) };
}

/** Grammar for the owner's id in human:<id> actors. */
export const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;

function positiveInt(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}

/** The actor for things the owner does in Obsidian. */
export function humanActor(settings: PluginSettings): string {
  return `human:${settings.userId || "owner"}`;
}

/** The MCP endpoint URL for a port. */
export function endpointUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp/`;
}

/** Ready-to-paste client configuration for a new token. */
export function clientSnippets(port: number, token: string, name = "okf-wiki"): { claudeCode: string; mcpJson: string } {
  const url = endpointUrl(port);
  return {
    claudeCode: `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${token}"`,
    mcpJson: JSON.stringify({ mcpServers: { [name]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  };
}
