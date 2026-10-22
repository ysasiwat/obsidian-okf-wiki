// Runs writes (DESIGN.md §6): authorize, queue per bundle, re-read the current text, plan,
// snapshot, write the concept, then index.md and log.md, update the model and audit.
// Decisions about content live in core/write.ts and core/move.ts; this file decides
// whether and when a write may happen.

import { analyzeBundle, type BundleModel } from "../core/bundle";
import { strictConceptIdErrors } from "../core/conceptId";
import { renderAllIndexes } from "../core/indexRender";
import { appendLogEntries, utcDate, type LogAction, type LogEntry } from "../core/logRender";
import { planMoveRewrites, rewriteLogLinks } from "../core/move";
import { encodeLinkTarget, normalizePath } from "../core/paths";
import { zoneOf } from "../core/policy";
import { scriptStats } from "../core/language";
import { parseConcept } from "../core/document";
import { trustFingerprint, trustTier } from "../core/trust";
import { etagOf, pathForId, planWrite, WriteError, type WritePlan, type WriteRequest } from "../core/write";
import { AUTO_APPROVE_ACTOR } from "./autoApprove";
import {
  ServiceError, WriteConflict,
  type AuditLog, type BundleHandle, type BundleProvider, type CommitEvent, type CommitFile, type CommitRecord,
  type FilePort, type Principal, type SnapshotStore, type TrustLedger,
} from "./types";

export const BEING_EDITED_MS = 10_000;

export interface WriteOptions {
  /** Numbers, or getters so settings changes apply without a restart. */
  perMinute?: number | (() => number);
  perDay?: number | (() => number);
  /** True while the owner has paused agent writes. */
  paused?: () => boolean;
  now?: () => Date;
  newId?: () => string;
  log?: (message: string, error?: unknown) => void;
  trust?: TrustLedger;
  /** Told about every commit once it is on disk, revert included; never delays or fails the write. */
  onCommit?: (event: CommitEvent) => void;
  /** Whether to approve a token's write at once, as process:auto-approve (autoApprove.ts). */
  autoApprove?: (tokenName: string, bundle: string, conceptId: string, tool: string) => boolean;
}

const AUTO_APPROVER: Writer = {
  kind: "token",
  principal: { tokenName: "auto-approve", kind: "process", scopes: new Set(["verify", "publish"]), bundles: "*", pathPrefixes: [] },
  actor: AUTO_APPROVE_ACTOR,
};

/** Who a write is for: an MCP token, or a person acting in Obsidian. */
export type Writer =
  | { kind: "token"; principal: Principal; actor: string }
  | { kind: "human"; actor: string };

export interface WriteResult {
  bundle: string;
  concept_id: string;
  path: string;
  changed: boolean;
  etag: string | null;
  status?: string | null;
  trust_tier?: string;
  warnings: string[];
  commit_id?: string;
  duplicate_of?: string;
}

function toServiceError(e: WriteError): ServiceError {
  return new ServiceError(e.code, e.message, e.hint, e.data);
}

export class WriteService {
  private queues = new Map<string, Promise<unknown>>();
  private recent = new Map<string, number[]>();

  constructor(
    private readonly provider: BundleProvider,
    private readonly files: FilePort,
    private readonly snapshots: SnapshotStore,
    private readonly audit: AuditLog,
    private readonly options: WriteOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private newId(): string {
    return this.options.newId?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---- authorization --------------------------------------------------------------

  private handle(writer: Writer, bundle: string | undefined): BundleHandle {
    const all = this.provider.bundles();
    const visible = writer.kind === "human" ? all : all.filter((b) => writer.principal.bundles === "*" || writer.principal.bundles.includes(b.name));
    if (!bundle) {
      if (visible.length === 1) return visible[0]!;
      throw new ServiceError("ambiguous", visible.length ? `Several bundles are available: ${visible.map((b) => b.name).join(", ")}.` : "No bundles are available to this token.", "Pass `bundle`.");
    }
    const b = visible.find((x) => x.name === bundle);
    if (!b) throw new ServiceError("not-found", `Bundle '${bundle}' does not exist or is not available to this token.`);
    return b;
  }

  private authorize(writer: Writer, paths: string[], scope = "write"): void {
    if (writer.kind === "human") return;
    const p = writer.principal;
    if (!p.scopes.has("write")) throw new ServiceError("forbidden", "This token cannot write.", "Ask the vault owner for a token with the write scope.");
    if (scope !== "write" && !p.scopes.has(scope as never)) throw new ServiceError("forbidden", `This needs the ${scope} scope.`);
    for (const path of paths) {
      const ok = p.pathPrefixes.length === 0 || p.pathPrefixes.some((pre) => path.startsWith(pre.endsWith("/") ? pre : `${pre}/`));
      if (!ok) throw new ServiceError("forbidden", `This token may not write '${path.replace(/\.md$/, "")}'.`, `It may write under: ${p.pathPrefixes.join(", ")}.`);
    }
    if (this.options.paused?.()) {
      throw new ServiceError("paused", "The vault owner has paused agent writes.", "Reads still work. Try again later.");
    }
    this.checkQuota(p.tokenName);
  }

  private checkQuota(token: string): void {
    const now = this.now().getTime();
    const times = (this.recent.get(token) ?? []).filter((t) => t > now - 86_400_000);
    this.recent.set(token, times);
    const value = (v: number | (() => number) | undefined, d: number) => (typeof v === "function" ? v() : (v ?? d));
    const perMinute = value(this.options.perMinute, 30);
    const perDay = value(this.options.perDay, 500);
    const lastMinute = times.filter((t) => t > now - 60_000);
    if (lastMinute.length >= perMinute) {
      throw new ServiceError("rate-limited", `More than ${perMinute} writes in a minute.`, "Slow down and retry.", { retry_after: Math.ceil((lastMinute[0]! + 60_000 - now) / 1000) });
    }
    if (times.length >= perDay) {
      throw new ServiceError("rate-limited", `More than ${perDay} writes today.`, "Ask the vault owner to raise the daily limit.", { retry_after: Math.ceil((times[0]! + 86_400_000 - now) / 1000) });
    }
  }

  private countWrite(writer: Writer): void {
    if (writer.kind !== "token") return;
    const t = writer.principal.tokenName;
    this.recent.set(t, [...(this.recent.get(t) ?? []), this.now().getTime()]);
  }

  private can(writer: Writer): (scope: string) => boolean {
    return (scope) => writer.kind === "human" || writer.principal.scopes.has(scope as never);
  }

  private notBeingEdited(bundle: string, paths: string[]): void {
    for (const p of paths) {
      const ms = this.files.msSinceHumanInput(bundle, p);
      if (ms !== null && ms < BEING_EDITED_MS) {
        throw new ServiceError("being-edited", `A person is editing '${p.replace(/\.md$/, "")}' in Obsidian right now.`, `Retry in ${Math.ceil((BEING_EDITED_MS - ms) / 1000) + 1} seconds.`, {
          retry_after: Math.ceil((BEING_EDITED_MS - ms) / 1000) + 1,
        });
      }
    }
  }

  /** Run `task` after every earlier write to the same bundle. */
  private enqueue<T>(bundle: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(bundle) ?? Promise.resolve();
    const run = prev.then(task, task);
    this.queues.set(bundle, run.catch(() => undefined));
    return run;
  }

  // ---- writes -----------------------------------------------------------------------

  /** Target path of a request, for authorization before planning. */
  private targetPath(req: WriteRequest, model: BundleModel): string {
    if (req.kind === "ingest_raw") {
      const dir = (req.dir ?? model.policy.raw_dirs[0] ?? "").replace(/^\/+|\/+$/g, "");
      return `${dir}/${req.slug}.md`;
    }
    try {
      return pathForId(req.conceptId);
    } catch (e) {
      if (e instanceof WriteError) throw toServiceError(e);
      throw e;
    }
  }

  async write(writer: Writer, bundleName: string | undefined, req: WriteRequest, tool: string): Promise<WriteResult> {
    const handle = this.handle(writer, bundleName);
    const path = this.targetPath(req, handle.model);
    const extra = req.kind === "publish" ? "publish" : "write";
    this.authorize(writer, [path], extra);

    return this.enqueue(handle.name, async () => {
      const b = this.provider.bundles().find((x) => x.name === handle.name) ?? handle;
      const current = await this.files.read(b.name, path);
      // A person's own actions (approve, stamp) never wait for their own typing.
      if (writer.kind === "token") this.notBeingEdited(b.name, [path]);
      let plan: WritePlan;
      try {
        plan = planWrite(req, { model: b.model, actor: writer.actor, can: this.can(writer), now: this.now(), textOf: (p) => (p === path ? current : undefined) });
      } catch (e) {
        if (e instanceof WriteError) {
          await this.auditRefusal(writer, b.name, tool, path, e.code, req);
          throw toServiceError(e);
        }
        throw e;
      }
      if (!plan.changed) {
        await this.safeAudit({ ...this.auditBase(writer, b.name, tool, plan.conceptId), outcome: "unchanged" });
        return { bundle: b.name, concept_id: plan.conceptId, path: plan.path, changed: false, etag: plan.before === null ? null : etagOf(plan.before), warnings: plan.warnings, ...(plan.duplicateOf ? { duplicate_of: plan.duplicateOf } : {}) };
      }
      const commit = await this.commit(writer, b, tool, plan.conceptId, plan.reason, [{ path: plan.path, before: plan.before, after: plan.after }], plan.action, plan.title);
      let text = plan.after;
      if (writer.kind === "token" && this.options.autoApprove?.(writer.principal.tokenName, b.name, plan.conceptId, tool)) {
        text = (await this.approveNow(b.name, plan.conceptId, writer.principal.tokenName)) ?? text;
      }
      const model = this.provider.bundles().find((x) => x.name === b.name)?.model;
      const c = model?.concepts.get(plan.path);
      return {
        bundle: b.name,
        concept_id: plan.conceptId,
        path: plan.path,
        changed: true,
        etag: etagOf(text),
        status: c?.status ?? null,
        ...(c ? { trust_tier: trustTier(c.frontmatter) } : {}),
        warnings: [...plan.warnings, ...commit.warnings],
        commit_id: commit.id,
      };
    });
  }

  async move(writer: Writer, bundleName: string | undefined, args: { from: string; to: string; ifMatch: string; reason: string }, tool = "okf_move"): Promise<WriteResult> {
    const handle = this.handle(writer, bundleName);
    const wrap = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof WriteError) throw toServiceError(e);
        throw e;
      }
    };
    const from = wrap(() => pathForId(args.from));
    const to = wrap(() => pathForId(args.to));
    this.authorize(writer, [from, to]);
    const idErrors = strictConceptIdErrors(to.replace(/\.md$/, ""));
    if (idErrors.length) throw new ServiceError("invalid-argument", `New id: ${idErrors.join("; ")}`);
    const reason = args.reason?.replace(/\s+/g, " ").trim();
    if (!reason) throw new ServiceError("invalid-argument", "`reason` is required");
    if (scriptStats(reason).nonLatin > 0) throw new ServiceError("policy", "`reason` must be English");

    return this.enqueue(handle.name, async () => {
      const b = this.provider.bundles().find((x) => x.name === handle.name) ?? handle;
      const concept = b.model.concepts.get(from);
      if (!concept) throw new ServiceError("not-found", `Concept '${args.from}' does not exist`);
      if (b.model.files.has(to)) throw new ServiceError("exists", `'${args.to}' already exists`);
      if (zoneOf(from, b.model.policy) !== zoneOf(to, b.model.policy)) {
        throw new ServiceError("policy", "A concept cannot move between the curated and raw zones", "Raw sources stay in raw directories; curated concepts stay outside them.");
      }
      const current = await this.files.read(b.name, from);
      if (current === undefined || etagOf(current) !== args.ifMatch) {
        throw new ServiceError("conflict", "The concept changed since you read it", "Read it again and retry with the new etag.", { etag: current === undefined ? null : etagOf(current) });
      }
      const rewrites = planMoveRewrites(b.model, from, to);
      const touched = [from, ...[...rewrites.keys()].filter((p) => p !== to)];
      this.notBeingEdited(b.name, touched);
      const files: CommitFile[] = [
        { path: from, before: current, after: null },
        { path: to, before: null, after: rewrites.get(to) ?? current },
        ...[...rewrites].filter(([p]) => p !== to).map(([p, t]) => ({ path: p, before: b.model.files.get(p) ?? null, after: t })),
      ];
      const commit = await this.commit(writer, b, tool, to.replace(/\.md$/, ""), reason, files, "Move", concept.title, { from, to });
      return { bundle: b.name, concept_id: to.replace(/\.md$/, ""), path: to, changed: true, etag: etagOf(rewrites.get(to) ?? current), status: concept.status, warnings: commit.warnings, commit_id: commit.id };
    });
  }

  async describeDirectory(writer: Writer, bundleName: string | undefined, dirArg: string, description: string): Promise<WriteResult> {
    const handle = this.handle(writer, bundleName);
    const dir = normalizePath(dirArg.replace(/^\/+|\/+$/g, ""));
    if (!dir) throw new ServiceError("invalid-argument", "Name a directory inside the bundle; the root has no parent index");
    this.authorize(writer, [`${dir}/index.md`]);
    const desc = description.replace(/\s+/g, " ").trim();
    if (!desc || desc.length > 200) throw new ServiceError("invalid-argument", "description must be one line of at most 200 characters");
    if (scriptStats(desc).nonLatin > 0) throw new ServiceError("policy", "description must be English");
    return this.enqueue(handle.name, async () => {
      const b = this.provider.bundles().find((x) => x.name === handle.name) ?? handle;
      if (!b.model.policy.auto_index) throw new ServiceError("policy", "This bundle manages its index.md files by hand (auto_index: false)");
      if (![...b.model.concepts.keys(), ...b.model.files.keys()].some((p) => p.startsWith(`${dir}/`))) throw new ServiceError("not-found", `Directory '${dir}' is empty or does not exist`);
      const commit = await this.commit(writer, b, "okf_describe_directory", dir, undefined, [], null, dir, undefined, new Map([[dir, desc]]));
      return { bundle: b.name, concept_id: dir, path: `${dir}/index.md`, changed: commit.files.length > 0, etag: null, warnings: commit.warnings, ...(commit.files.length ? { commit_id: commit.id } : {}) };
    });
  }

  /**
   * Write the planned files plus the index.md and log.md changes they cause, recording a
   * snapshot first and applying the result to the model at once.
   */
  private async commit(
    writer: Writer,
    b: BundleHandle,
    tool: string,
    conceptId: string,
    reason: string | undefined,
    planned: CommitFile[],
    action: LogAction | null,
    title: string,
    move?: { from: string; to: string },
    descriptions?: ReadonlyMap<string, string>,
    /** The caller emits the commit event itself (revert, which also restored files). */
    quiet = false,
  ): Promise<{ id: string; files: CommitFile[]; written: CommitFile[]; warnings: string[] }> {
    const warnings: string[] = [];
    const files = new Map(b.model.files);
    for (const f of planned) {
      if (f.after === null) files.delete(f.path);
      else files.set(f.path, f.after);
    }
    const after = analyzeBundle(files, b.model);
    const all: CommitFile[] = [...planned];

    if (b.model.policy.auto_index) {
      // Only the directories a write touches and their ancestors (DESIGN.md §4.5), so indexes
      // a person wrote elsewhere are left alone.
      const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
      const affected = new Set<string>([""]);
      for (const f of planned) for (let d = dirOf(f.path); d !== ""; d = dirOf(d)) affected.add(d);
      for (const [path, text] of renderAllIndexes(after, descriptions, affected)) {
        const before = b.model.files.get(path) ?? null;
        if (before !== text) all.push({ path, before, after: text });
      }
    }
    if (b.model.policy.auto_log && action) {
      const entry: LogEntry = {
        date: utcDate(this.now()),
        action,
        title,
        link: encodeLinkTarget(move?.to ?? `${conceptId}.md`),
        actor: writer.actor,
        ...(reason ? { reason: move ? `${reason} (from ${move.from.replace(/\.md$/, "")})` : reason } : {}),
      };
      const before = b.model.files.get("log.md") ?? null;
      // History of a moved concept keeps working links: earlier entries point to its new path.
      const base = before !== null && move ? rewriteLogLinks(before, move.from, move.to) : before;
      all.push({ path: "log.md", before, after: appendLogEntries(base ?? undefined, [entry]) });
    }
    if (all.length === 0) return { id: "", files: [], written: [], warnings };

    const record: CommitRecord = {
      id: this.newId(),
      at: this.now().toISOString(),
      bundle: b.name,
      actor: writer.actor,
      token: writer.kind === "token" ? writer.principal.tokenName : null,
      tool,
      conceptId,
      ...(reason ? { reason } : {}),
      files: all,
    };
    await this.snapshots.save(record);

    // The concept files first: a conflict there aborts the whole commit.
    const applied = new Map<string, string | null>();
    try {
      for (const f of planned) {
        if (move && f.path === move.from) {
          await this.files.rename(b.name, move.from, move.to);
          applied.set(move.from, null);
          continue;
        }
        if (f.after === null) continue;
        const expected = move && f.path === move.to ? null : f.before === null ? null : etagOf(f.before);
        if (move && f.path === move.to) {
          // The renamed file now holds the old text; rewrite its links in place.
          if (f.after !== f.before) await this.files.write(b.name, f.path, f.after, etagOf(planned.find((x) => x.path === move.from)!.before!));
        } else {
          await this.files.write(b.name, f.path, f.after, expected);
        }
        applied.set(f.path, f.after);
      }
    } catch (e) {
      if (applied.size === 0) await this.snapshots.discard(record.id);
      if (e instanceof WriteConflict) {
        throw new ServiceError("conflict", applied.size === 0 ? "The concept changed while the write was being prepared" : `Part of the change could not be written: ${String(e.message)}`, applied.size === 0 ? "Read it again and retry." : `The vault owner can undo the partial change with Revert (commit ${record.id}).`);
      }
      throw e;
    }

    // Maintained files: a conflict (a person editing index.md or log.md) only warns.
    for (const f of all.slice(planned.length)) {
      try {
        await this.files.write(b.name, f.path, f.after!, f.before === null ? null : etagOf(f.before));
        applied.set(f.path, f.after);
      } catch (e) {
        warnings.push(`${f.path} was not updated: ${String((e as Error).message)}`);
        this.options.log?.(`could not update ${f.path}`, e);
      }
    }
    this.provider.applyLocal?.(b.name, applied);
    this.recordTrust(b.name, applied);
    this.countWrite(writer);
    await this.safeAudit({
      ...this.auditBase(writer, b.name, tool, conceptId),
      outcome: "written",
      commit_id: record.id,
      etag_before: planned[0]?.before == null ? null : etagOf(planned[0].before),
      ...(planned[0]?.after ? { etag_after: etagOf(planned[0].after) } : {}),
      ...(reason ? { reason } : {}),
    });
    const written = all.filter((f) => applied.has(f.path));
    if (!quiet) this.emitCommit(record, written);
    return { id: record.id, files: all, written, warnings };
  }

  private emitCommit(record: Omit<CommitRecord, "files" | "token">, files: CommitFile[], reverts?: string): void {
    const listener = this.options.onCommit;
    if (!listener || files.length === 0) return;
    const event: CommitEvent = {
      commitId: record.id,
      at: record.at,
      bundle: record.bundle,
      actor: record.actor,
      tool: record.tool,
      conceptId: record.conceptId,
      ...(record.reason ? { reason: record.reason } : {}),
      ...(reverts ? { reverts } : {}),
      changes: files.map((f) => ({ path: f.path, change: f.before === null ? "created" : f.after === null ? "deleted" : "modified" })),
    };
    // Next turn of the event loop, so a slow or failing listener never holds up or breaks a write.
    setTimeout(() => {
      try {
        listener(event);
      } catch (e) {
        this.options.log?.("commit listener failed", e);
      }
    }, 0);
  }

  /**
   * Auto approve, inside the queued write that just committed: the agent's result then carries
   * the approved etag, so its next write does not conflict. Returns the new text, or null.
   */
  private async approveNow(bundle: string, conceptId: string, tokenName: string): Promise<string | null> {
    try {
      const b = this.provider.bundles().find((x) => x.name === bundle);
      if (!b) return null;
      const path = `${conceptId}.md`;
      const current = await this.files.read(bundle, path);
      const note = `Auto-approved a write by ${tokenName} that passed the rules.`;
      const plan = planWrite({ kind: "verify", conceptId, approve: true, note }, { model: b.model, actor: AUTO_APPROVER.actor, can: this.can(AUTO_APPROVER), now: this.now(), textOf: (p) => (p === path ? current : undefined) });
      if (!plan.changed) return null;
      await this.commit(AUTO_APPROVER, b, "auto_approve", conceptId, plan.reason, [{ path, before: plan.before, after: plan.after }], plan.action, plan.title);
      return plan.after;
    } catch (e) {
      // The agent's write is on disk; the concept just stays in the Review Queue.
      this.options.log?.(`auto approve of ${bundle}/${conceptId} failed`, e);
      return null;
    }
  }

  /**
   * Reject (Review Queue, by a person): revert the latest change a token made to the concept,
   * recording the person's reason in log.md so agents see it in okf_history.
   */
  async reject(actor: string, bundle: string, conceptId: string, reason: string): Promise<{ commit_id: string; files: string[] }> {
    const note = reason.replace(/\s+/g, " ").trim();
    if (!note) throw new ServiceError("invalid-argument", "Give a reason, so the agent knows what to change");
    const path = `${conceptId}.md`;
    const touches = (r: CommitRecord) => r.bundle === bundle && r.tool !== "revert" && !r.actor.startsWith("human:") && r.files.some((f) => f.path === path);
    // shortcut: reads up to 200 snapshots, newest first; index them by concept if rejects get slow.
    const records = (await this.snapshots.list(200)).filter(touches);
    const [latest, previous] = records;
    if (!latest) throw new ServiceError("not-found", `No recent agent change to '${conceptId}' (snapshots are kept for 7 days)`, "Edit or delete the note by hand.");
    const result = await this.revert(actor, latest.id, `Rejected: ${note}`);
    // An auto approval is undone together with the write it approved.
    if (latest.tool === "auto_approve" && previous) return this.revert(actor, previous.id, `Rejected: ${note}`);
    return result;
  }

  /** Undo a commit (Obsidian command, by a person). Refuses if any file changed since. */
  async revert(actor: string, commitId: string, why?: string): Promise<{ commit_id: string; files: string[] }> {
    const record = await this.snapshots.get(commitId);
    if (!record) throw new ServiceError("not-found", `No snapshot for commit ${commitId} (snapshots are kept for 7 days)`);
    const writer: Writer = { kind: "human", actor };
    return this.enqueue(record.bundle, async () => {
      const b = this.provider.bundles().find((x) => x.name === record.bundle);
      if (!b) throw new ServiceError("not-found", `Bundle '${record.bundle}' is not loaded`);
      // index.md and log.md are regenerated rather than restored, so later commits that
      // touched them do not block a revert; only the concept files must be as committed.
      const isMaintained = (p: string) => p === "log.md" || p === "index.md" || p.endsWith("/index.md");
      const concept: CommitFile[] = record.files
        .filter((f) => !isMaintained(f.path))
        .map((f) => ({ path: f.path, before: f.after, after: f.before }));
      const changed: string[] = [];
      for (const f of concept) {
        const now = await this.files.read(b.name, f.path);
        if ((now ?? null) !== f.before) changed.push(f.path);
      }
      if (changed.length) {
        throw new ServiceError("conflict", `These files changed after the commit: ${changed.join(", ")}`, "Revert the later commits first, or restore by hand.");
      }
      // Restore concepts directly; regenerate indexes and log through commit().
      for (const f of concept) {
        if (f.after === null) await this.files.trash(b.name, f.path);
        else await this.files.write(b.name, f.path, f.after, f.before === null ? null : etagOf(f.before));
      }
      const restored = new Map(concept.map((f) => [f.path, f.after]));
      this.provider.applyLocal?.(b.name, restored);
      this.recordTrust(b.name, restored);
      const fresh = this.provider.bundles().find((x) => x.name === b.name) ?? b;
      const reason = why ? `${why} (revert of commit ${record.id})` : `Revert commit ${record.id}`;
      const result = await this.commit(writer, fresh, "revert", record.conceptId, reason, [], "Revert", record.conceptId, undefined, undefined, true);
      const commitId = result.id || record.id;
      // One event with the restored files as well as the regenerated index.md and log.md.
      this.emitCommit({ id: commitId, at: this.now().toISOString(), bundle: b.name, actor, tool: "revert", conceptId: record.conceptId, reason }, [...concept, ...result.written], record.id);
      return { commit_id: commitId, files: concept.map((f) => f.path) };
    });
  }

  /** Everything written through the pipeline is attested; remember its trust state. */
  private recordTrust(bundle: string, changes: ReadonlyMap<string, string | null>): void {
    const trust = this.options.trust;
    if (!trust) return;
    for (const [path, text] of changes) {
      if (!path.endsWith(".md") || path === "log.md" || path === "index.md" || path.endsWith("/index.md")) continue;
      if (text === null) {
        trust.set(bundle, path, null);
        continue;
      }
      try {
        trust.set(bundle, path, trustFingerprint(parseConcept(text).frontmatter));
      } catch {
        trust.set(bundle, path, null);
      }
    }
  }

  private auditBase(writer: Writer, bundle: string, tool: string, conceptId: string) {
    return {
      at: this.now().toISOString(),
      token: writer.kind === "token" ? writer.principal.tokenName : null,
      actor: writer.actor,
      tool,
      bundle,
      concept_id: conceptId,
    };
  }

  private async auditRefusal(writer: Writer, bundle: string, tool: string, path: string, code: string, req: WriteRequest): Promise<void> {
    await this.safeAudit({ ...this.auditBase(writer, bundle, tool, path.replace(/\.md$/, "")), outcome: "refused", code, ...("reason" in req && req.reason ? { reason: req.reason } : {}) });
  }

  private async safeAudit(entry: Parameters<AuditLog["append"]>[0]): Promise<void> {
    try {
      await this.audit.append(entry);
    } catch (e) {
      this.options.log?.("audit append failed", e);
    }
  }
}
