// Access tokens (DESIGN.md §8). Only a SHA-256 hash of each token is stored, so plugin
// settings synced through git or a cloud service never carry a usable credential. Tokens
// are 256 random bits, so a fast hash is sufficient. Comparison is constant-time.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { STRICT_SEGMENT } from "../core/conceptId";
import { SCOPES, type Principal, type Scope } from "../service/types";

export const TOKEN_PREFIX = "okf_";

export interface TokenRecord {
  id: string;
  /** Also the actor prefix stamped on this token's writes, so it follows the id grammar. */
  name: string;
  kind: "agent" | "process";
  scopes: Scope[];
  bundles: string[] | "*";
  pathPrefixes: string[];
  /** Hex SHA-256 of the token. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new random token, shown to the owner once. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function tokenNameErrors(name: string): string[] {
  if (!STRICT_SEGMENT.test(name)) return ["Use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit."];
  if (name.length > 64) return ["Use at most 64 characters."];
  return [];
}

export function createTokenRecord(
  input: { name: string; kind?: "agent" | "process"; scopes?: Scope[]; bundles?: string[] | "*"; pathPrefixes?: string[] },
  now: Date = new Date(),
): { token: string; record: TokenRecord } {
  const errors = tokenNameErrors(input.name);
  if (errors.length > 0) throw new Error(`Invalid token name '${input.name}': ${errors.join(" ")}`);
  const scopes = input.scopes ?? ["read"];
  for (const s of scopes) if (!SCOPES.includes(s)) throw new Error(`Unknown scope '${s}'`);
  const token = generateToken();
  return {
    token,
    record: {
      id: randomBytes(8).toString("hex"),
      name: input.name,
      kind: input.kind ?? "agent",
      scopes: [...new Set(scopes)],
      bundles: input.bundles ?? "*",
      pathPrefixes: input.pathPrefixes ?? [],
      hash: hashToken(token),
      createdAt: now.toISOString(),
    },
  };
}

export function toPrincipal(record: TokenRecord): Principal {
  return {
    tokenName: record.name,
    kind: record.kind,
    scopes: new Set(record.scopes),
    bundles: record.bundles,
    pathPrefixes: record.pathPrefixes,
  };
}

/** Looks tokens up by hash. Records are read through a getter so revocation applies at once. */
export class TokenStore {
  constructor(
    private readonly records: () => readonly TokenRecord[],
    private readonly onUsed: (record: TokenRecord) => void = () => {},
  ) {}

  authenticate(token: string): TokenRecord | null {
    const presented = Buffer.from(hashToken(token), "hex");
    let match: TokenRecord | null = null;
    // Compare against every record so timing does not depend on which one matched.
    for (const r of this.records()) {
      const stored = Buffer.from(r.hash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = r;
    }
    if (match) this.onUsed(match);
    return match;
  }

  count(): number {
    return this.records().length;
  }
}
