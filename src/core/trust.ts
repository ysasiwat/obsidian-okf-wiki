// Trust, lifecycle and actor rules from OKF v0.2 §5 and §7.
// Behaviour follows SPEC.md and the reference implementation in
// open-knowledge-format src/reference_agent/bundle/document.py (Apache-2.0).

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export type Status = "draft" | "stable" | "deprecated";
export const STATUSES: readonly Status[] = ["draft", "stable", "deprecated"];

export interface VerificationEvent {
  by: string;
  at?: string;
}

/** An ISO 8601 datetime with an explicit UTC offset, as OKF requires for every timestamp. */
const ISO_WITH_OFFSET =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export function isIsoDateTimeWithOffset(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) return false;
  // Date.parse rolls 2026-02-30 over to March; check the calendar date itself.
  const [y, mo, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && !Number.isNaN(Date.parse(value));
}

/** `verified` as a list: a bare mapping is a one-element list (§5.2). */
export function normalizeVerified(frontmatter: Record<string, unknown>): VerificationEvent[] {
  const v = frontmatter["verified"];
  const items = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  return items.filter(
    (e): e is VerificationEvent =>
      !!e && typeof e === "object" && typeof (e as { by?: unknown }).by === "string",
  );
}

/** Trust tier derived from `verified` (§5.3). */
export function trustTier(frontmatter: Record<string, unknown>): TrustTier {
  const events = normalizeVerified(frontmatter);
  if (events.length === 0) return "unverified";
  return events.some((e) => e.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

export const TRUST_RANK: Record<TrustTier, number> = {
  unverified: 0,
  "machine-confirmed": 1,
  "human-reviewed": 2,
};

/** Lifecycle status; absent means stable (§5.4). Unknown values are returned as null. */
export function lifecycleStatus(frontmatter: Record<string, unknown>): Status | null {
  const s = frontmatter["status"];
  if (s === undefined || s === null) return "stable";
  return STATUSES.includes(s as Status) ? (s as Status) : null;
}

/**
 * Whether the concept is stale (§5.5): `now >= stale_after`. A value that is not an
 * ISO datetime with an explicit offset is ignored, as a date-only value names a
 * different instant in every timezone.
 */
export function isStale(frontmatter: Record<string, unknown>, now: Date = new Date()): boolean {
  const raw = frontmatter["stale_after"];
  if (!isIsoDateTimeWithOffset(raw)) return false;
  return now.getTime() >= Date.parse(raw);
}

/** When the content last meaningfully changed: `generated.at`, else legacy v0.1 `timestamp`. */
export function generatedAt(frontmatter: Record<string, unknown>): string | null {
  const g = frontmatter["generated"];
  if (g && typeof g === "object" && isIsoDateTimeWithOffset((g as { at?: unknown }).at)) {
    return (g as { at: string }).at;
  }
  const legacy = frontmatter["timestamp"];
  return isIsoDateTimeWithOffset(legacy) ? legacy : null;
}

/**
 * True when content changed after its latest verification. Derived, never stored:
 * `verified` and `generated` are independent in the spec (§5.2), so a stale
 * verification is reported rather than removed.
 */
export function verificationOutdated(frontmatter: Record<string, unknown>): boolean {
  const changed = generatedAt(frontmatter);
  const times = normalizeVerified(frontmatter)
    .map((e) => e.at)
    .filter(isIsoDateTimeWithOffset)
    .map((t) => Date.parse(t));
  if (changed === null || times.length === 0) return false;
  return Math.max(...times) < Date.parse(changed);
}

/**
 * What the trust snapshot (DESIGN.md §5.1) remembers about a concept: its status and
 * verification events, independent of YAML layout, so a Properties UI reformat matches
 * but an added `verified` or a status change made outside the plugin does not.
 */
export function trustFingerprint(frontmatter: Record<string, unknown>): string {
  return JSON.stringify({
    status: lifecycleStatus(frontmatter),
    verified: normalizeVerified(frontmatter).map((e) => [e.by, e.at ?? null]),
  });
}

// Actors (§7): `<producer>/<version>`, `human:<id>`, `process:<id>`.
export type Actor =
  | { kind: "human"; id: string }
  | { kind: "process"; id: string }
  | { kind: "agent"; producer: string; version: string };

const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;
const PRODUCER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseActor(value: unknown): Actor | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("human:")) {
    const id = value.slice(6);
    return ACTOR_ID.test(id) ? { kind: "human", id } : null;
  }
  if (value.startsWith("process:")) {
    const id = value.slice(8);
    return ACTOR_ID.test(id) ? { kind: "process", id } : null;
  }
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const producer = value.slice(0, slash);
  const version = value.slice(slash + 1);
  return PRODUCER.test(producer) && version.length > 0 && !/\s/.test(version)
    ? { kind: "agent", producer, version }
    : null;
}

export function formatActor(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return `human:${actor.id}`;
    case "process":
      return `process:${actor.id}`;
    case "agent":
      return `${actor.producer}/${actor.version}`;
  }
}

/** Current time as an OKF timestamp: UTC, second precision. */
export function okfNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
