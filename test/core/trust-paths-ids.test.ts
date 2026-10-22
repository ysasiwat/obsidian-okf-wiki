import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import {
  generatedAt, isIsoDateTimeWithOffset, isStale, lifecycleStatus, normalizeVerified,
  okfNow, parseActor, formatActor, trustTier, verificationOutdated,
} from "../../src/core/trust";
import { strictConceptIdErrors, isReservedFilename } from "../../src/core/conceptId";
import {
  decodeLinkTarget, normalizePath, relativePath, resolveBodyLink, resolveFieldPath, joinPath, dirname,
} from "../../src/core/paths";
import { sha256Hex } from "../../src/core/sha256";

describe("trust (OKF §5)", () => {
  it("treats a bare verified mapping as a one-element list", () => {
    expect(normalizeVerified({ verified: { by: "human:a", at: "2026-01-01T00:00:00Z" } })).toHaveLength(1);
    expect(normalizeVerified({ verified: "nonsense" })).toEqual([]);
  });

  it("derives trust tiers", () => {
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: [{ by: "process:nightly" }] })).toBe("machine-confirmed");
    expect(trustTier({ verified: [{ by: "process:nightly" }, { by: "human:ys" }] })).toBe("human-reviewed");
  });

  it("computes staleness only from datetimes with an explicit offset", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    expect(isStale({ stale_after: "2026-10-13T23:59:59Z" }, now)).toBe(true);
    expect(isStale({ stale_after: "2026-10-14T00:00:00Z" }, now)).toBe(true);
    expect(isStale({ stale_after: "2026-10-14T07:00:01+07:00" }, now)).toBe(false);
    expect(isStale({ stale_after: "2026-01-01" }, now)).toBe(false);
    expect(isStale({ stale_after: "2026-01-01T00:00:00" }, now)).toBe(false);
    expect(isStale({}, now)).toBe(false);
  });

  it("validates ISO datetimes", () => {
    expect(isIsoDateTimeWithOffset("2026-06-30T14:00:00Z")).toBe(true);
    expect(isIsoDateTimeWithOffset("2026-06-30T14:00Z")).toBe(true);
    expect(isIsoDateTimeWithOffset("2026-02-30T14:00:00Z")).toBe(false);
    expect(isIsoDateTimeWithOffset("2026-13-01T00:00:00Z")).toBe(false);
  });

  it("defaults status to stable and flags unknown values", () => {
    expect(lifecycleStatus({})).toBe("stable");
    expect(lifecycleStatus({ status: "draft" })).toBe("draft");
    expect(lifecycleStatus({ status: "retired" })).toBeNull();
  });

  it("falls back to legacy timestamp and detects outdated verification", () => {
    expect(generatedAt({ timestamp: "2026-05-28T22:53:05+00:00" })).toBe("2026-05-28T22:53:05+00:00");
    const fm = {
      generated: { by: "a/1", at: "2026-07-02T00:00:00Z" },
      verified: { by: "human:x", at: "2026-07-01T00:00:00Z" },
    };
    expect(verificationOutdated(fm)).toBe(true);
    expect(verificationOutdated({ ...fm, verified: { by: "human:x", at: "2026-07-03T00:00:00Z" } })).toBe(false);
  });

  it("parses and formats actors", () => {
    for (const a of ["human:jsmith@acme", "process:finance-nightly", "reference_agent/gemini-2.5-pro"]) {
      expect(formatActor(parseActor(a)!)).toBe(a);
    }
    expect(parseActor("human:")).toBeNull();
    expect(parseActor("no-slash")).toBeNull();
    expect(parseActor("team:finance")).toBeNull();
  });

  it("formats now as a second-precision UTC timestamp", () => {
    expect(okfNow(new Date("2026-10-14T01:02:03.456Z"))).toBe("2026-10-14T01:02:03Z");
  });
});

describe("concept ids", () => {
  it("accepts portable ids and rejects the rest", () => {
    expect(strictConceptIdErrors("tables/orders")).toEqual([]);
    expect(strictConceptIdErrors("references/raw/acme-annual-report-2025")).toEqual([]);
    for (const bad of ["Tables/orders", "a b", "con", "x/aux.txt", "a./b", "x/index", "log", "../x", "/x", "x.md", "ดาวเทียม", ""]) {
      expect(strictConceptIdErrors(bad).length, bad).toBeGreaterThan(0);
    }
  });

  it("recognizes reserved filenames", () => {
    expect(isReservedFilename("a/index.md")).toBe(true);
    expect(isReservedFilename("log.md")).toBe(true);
    expect(isReservedFilename("a/indexes.md")).toBe(false);
  });
});

describe("paths", () => {
  it("normalizes and never climbs above the bundle root", () => {
    expect(normalizePath("a/./b/../c")).toBe("a/c");
    expect(normalizePath("../x")).toBeNull();
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "..", ".", ""), { maxLength: 12 }), (segs) => {
        const n = normalizePath(segs.join("/"));
        return n === null || !n.split("/").includes("..");
      }),
    );
  });

  it("computes relative paths that resolve back", () => {
    const seg = fc.constantFrom("a", "b", "c");
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), fc.array(seg, { minLength: 1, maxLength: 4 }), (x, y) => {
        const from = `${x.join("/")}.md`;
        const to = `${y.join("/")}.md`;
        return joinPath(dirname(from), relativePath(from, to)) === to;
      }),
    );
    expect(relativePath("metrics/gross-margin.md", "computations/x.md")).toBe("../computations/x.md");
    expect(relativePath("metrics/a.md", "metrics/b.md")).toBe("b.md");
  });

  it("decodes link targets", () => {
    expect(decodeLinkTarget("<my file.md>")).toEqual({ path: "my file.md", fragment: "" });
    expect(decodeLinkTarget("a%20b.md#Schema")).toEqual({ path: "a b.md", fragment: "#Schema" });
  });

  it("resolves body links relative to the document, '/' to the bundle root", () => {
    expect(resolveBodyLink("metrics/a.md", "../tables/t.md")).toMatchObject({ resolved: "tables/t.md" });
    expect(resolveBodyLink("metrics/a.md", "/tables/t.md")).toMatchObject({ resolved: "tables/t.md" });
    expect(resolveBodyLink("a.md", "../../x.md")).toMatchObject({ kind: "outside" });
    expect(resolveBodyLink("a.md", "https://x.y/z")).toMatchObject({ kind: "url" });
  });

  it("resolves frontmatter paths both ways, as the OKF samples need", () => {
    const files = new Set(["skills/run-on-bq.md", "computations/skills/run-on-bq.md", "policies/p.md"]);
    const exists = (p: string) => files.has(p);
    // Sample style: bundle-relative without a slash.
    expect(resolveFieldPath("metrics/m.md", "policies/p.md", exists)).toMatchObject({ resolved: "policies/p.md", exists: true });
    // Both readings exist: ambiguous.
    expect(resolveFieldPath("computations/c.md", "skills/run-on-bq.md", exists)).toMatchObject({ ambiguous: "skills/run-on-bq.md" });
    expect(resolveFieldPath("a/b.md", "/policies/p.md", exists)).toMatchObject({ resolved: "policies/p.md", exists: true });
    expect(resolveFieldPath("a.md", "all queries in BigQuery project X", exists)).toMatchObject({ kind: "descriptor" });
    expect(resolveFieldPath("a.md", "bigquery://p/d/t", exists)).toMatchObject({ kind: "url" });
  });
});

describe("sha256", () => {
  it("matches node:crypto", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (s) => {
        return sha256Hex(s) === createHash("sha256").update(s, "utf8").digest("hex");
      }),
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
