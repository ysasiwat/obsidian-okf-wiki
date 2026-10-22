// Contracts between the knowledge service and the layers around it. Nothing here imports
// obsidian, so the service, MCP layer and HTTP server are testable in plain Node.

import type { BundleModel } from "../core/bundle";

export const SCOPES = ["read", "write", "verify", "publish", "computations:write", "raw:write", "delete"] as const;
export type Scope = (typeof SCOPES)[number];

/** Who is calling: an authenticated token and what it may see (DESIGN.md §8). */
export interface Principal {
  tokenName: string;
  kind: "agent" | "process";
  scopes: ReadonlySet<Scope>;
  /** Bundle names this token may use; "*" for all. */
  bundles: readonly string[] | "*";
  /** Path prefixes inside each bundle; empty means the whole bundle. */
  pathPrefixes: readonly string[];
}

export interface BundleHandle {
  /** Vault folder path of the bundle root, e.g. "Knowledge". */
  name: string;
  model: BundleModel;
  /** Increases whenever the model is rebuilt; used as a cache key. */
  version: number;
}

/** Supplies the current models of the bundles this device exposes. */
export interface BundleProvider {
  bundles(): BundleHandle[];
  /** False while the vault is still being indexed after startup. */
  ready(): boolean;
  /**
   * Apply files this process just wrote (null = removed) to the model at once, so the next
   * request sees them without waiting for vault events.
   */
  applyLocal?(bundle: string, changes: ReadonlyMap<string, string | null>): void;
  /**
   * Text of a non-markdown file. Models may keep such files as "" (only that they exist), so
   * okf_read_file asks the provider; null when it cannot be read safely.
   */
  readText?(bundle: string, path: string): Promise<string | null>;
}

/** File access for writes; paths are bundle-relative. Implemented over Obsidian in src/obsidian. */
export interface FilePort {
  /** Current text: the editor buffer when the file is open, else the file; undefined if absent. */
  read(bundle: string, path: string): Promise<string | undefined>;
  /**
   * Write `text`. `expectedEtag` is the etag of the text the write was planned against, or
   * null for a new file; implementations refuse with WriteConflict if the file differs.
   */
  write(bundle: string, path: string, text: string, expectedEtag: string | null): Promise<void>;
  /** Rename without Obsidian's link updating (links are rewritten by the planner). */
  rename(bundle: string, from: string, to: string): Promise<void>;
  /** Move to Obsidian's trash. */
  trash(bundle: string, path: string): Promise<void>;
  /** Milliseconds since a person last typed in this file in the editor, or null. */
  msSinceHumanInput(bundle: string, path: string): number | null;
}

export class WriteConflict extends Error {}

/**
 * The trust snapshot (DESIGN.md §5.1): per concept, the trustFingerprint of its last write
 * through this plugin. A file whose status or verified no longer matches was changed
 * outside the plugin (git, sync, a script, the Properties UI).
 */
export interface TrustLedger {
  get(bundle: string, path: string): string | undefined;
  /** null forgets the path. */
  set(bundle: string, path: string, fingerprint: string | null): void;
}

export interface CommitFile {
  path: string;
  /** null: the file did not exist. */
  before: string | null;
  /** null: the file was removed. */
  after: string | null;
}

/** A commit as extensions see it (DESIGN.md §13 4C): what was written, not the text. */
export interface CommitEvent {
  commitId: string;
  at: string;
  bundle: string;
  /** Who wrote it: `<token>/<version>`, `process:<name>` or `human:<id>`. */
  actor: string;
  tool: string;
  conceptId: string;
  reason?: string;
  /** For a revert: the commit it undid. */
  reverts?: string;
  /** Every file actually written, index.md and log.md included. A move is a delete and a create. */
  changes: { path: string; change: "created" | "modified" | "deleted" }[];
}

export interface CommitRecord {
  id: string;
  at: string;
  bundle: string;
  actor: string;
  token: string | null;
  tool: string;
  conceptId: string;
  reason?: string;
  files: CommitFile[];
}

/** Pre-write contents of every commit, kept for a limited time for revert (DESIGN.md §6.7). */
export interface SnapshotStore {
  save(record: CommitRecord): Promise<void>;
  discard(id: string): Promise<void>;
  get(id: string): Promise<CommitRecord | undefined>;
  /** Newest first. */
  list(limit: number): Promise<CommitRecord[]>;
}

export interface AuditEntry {
  at: string;
  token: string | null;
  actor: string;
  tool: string;
  bundle: string;
  concept_id: string;
  outcome: "written" | "unchanged" | "refused";
  code?: string;
  commit_id?: string;
  etag_before?: string | null;
  etag_after?: string;
  reason?: string;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
}

export type ServiceErrorCode =
  | "not-found" | "forbidden" | "invalid-argument" | "ambiguous" | "not-ready"
  | "exists" | "conflict" | "policy" | "paused" | "rate-limited" | "being-edited";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly hint?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
