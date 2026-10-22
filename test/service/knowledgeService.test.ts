import { describe, expect, it } from "vitest";
import { renderNewConcept } from "../../src/core/edit";
import { rawContentHash } from "../../src/core/raw";
import { conceptPathFromInput, decodeCursor, KnowledgeService } from "../../src/service/knowledgeService";
import { ServiceError } from "../../src/service/types";
import { fixtureProvider, MemoryProvider, principal } from "../helpers-service";

const NOW = () => new Date("2026-10-14T00:00:00Z");
const svc = new KnowledgeService(fixtureProvider("acme_retail", "ga4"), NOW);
const all = principal();

function err(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error("expected a ServiceError");
}

describe("bundle selection and ids", () => {
  it("lists bundles with counts", () => {
    const r = svc.listBundles(all);
    expect(r.bundles.map((b) => b.name)).toEqual(["acme_retail", "ga4"]);
    const acme = r.bundles[0]!;
    expect(acme.concepts).toBe(9);
    expect(acme.by_trust["human-reviewed"]).toBeGreaterThan(0);
    expect(acme.lint.error).toBe(0);
  });

  it("requires `bundle` when several are visible, and defaults when one is", () => {
    expect(err(() => svc.browse(all, {})).code).toBe("ambiguous");
    expect(svc.browse(principal({ bundles: ["ga4"] }), {}).bundle).toBe("ga4");
    expect(err(() => svc.browse(principal({ bundles: ["ga4"] }), { bundle: "acme_retail" })).code).toBe("not-found");
  });

  it("normalizes concept ids and rejects escapes", () => {
    expect(conceptPathFromInput("/tables/orders")).toBe("tables/orders.md");
    expect(conceptPathFromInput("tables/./orders.md")).toBe("tables/orders.md");
    for (const bad of ["../x", "a\\b", "C:/x", "a\0b", "  "]) expect(() => conceptPathFromInput(bad)).toThrow(ServiceError);
    expect(() => decodeCursor("!!")).toThrow(ServiceError);
  });
});

describe("browse and read", () => {
  it("browses directories with descriptions from the existing index", () => {
    const root = svc.browse(all, { bundle: "acme_retail" });
    expect(root.subdirectories.find((d) => d.dir === "metrics")?.description).toMatch(/headline numbers/);
    const attesters = svc.browse(all, { bundle: "acme_retail", dir: "attesters" });
    expect(attesters.files).toEqual(["attesters/sql_equality.py"]);
    expect(err(() => svc.browse(all, { bundle: "acme_retail", dir: "nope" })).code).toBe("not-found");
  });

  it("reads a concept with derived trust, links, sources and an etag", () => {
    const r = svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin" });
    expect(r).toMatchObject({ concept_id: "metrics/gross-margin", trust_tier: "human-reviewed", stale: false, zone: "curated", language: "en" });
    expect(r.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(r.links.outgoing.map((l) => l.resolved)).toContain("metrics/gross-margin-legacy");
    expect(r.sources.find((s) => s.id === "margin-standard")?.resolved_concept_id).toBe("policies/margin-standard");
  });

  it("serves outline, section and paged views", () => {
    const outline = svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin", view: "outline" });
    expect(outline.outline!.map((h) => h.text)).toContain("Definition");
    const section = svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin", view: "section", section: ["Definition"] });
    expect(section.body!.startsWith("# Definition")).toBe(true);
    const paged = svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin", max_chars: 100 });
    expect(paged).toMatchObject({ truncated: true, next_offset: 100 });
    const rest = svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin", offset: 100, max_chars: 100_000 });
    expect(paged.body! + rest.body!).toBe(svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin" }).body);
    expect(err(() => svc.read(all, { bundle: "acme_retail", concept_id: "metrics/gross-margin", view: "section" })).code).toBe("invalid-argument");
  });

  it("explains that index.md is not a concept", () => {
    expect(err(() => svc.read(all, { bundle: "acme_retail", concept_id: "index" })).hint).toMatch(/okf_browse/);
  });
});

describe("search", () => {
  it("ranks by relevance and excludes deprecated concepts by default", () => {
    const r = svc.search(all, { bundle: "acme_retail", query: "gross margin" });
    expect(r.hits[0]?.concept_id).toMatch(/gross-margin/);
    expect(r.hits.map((h) => h.concept_id)).not.toContain("metrics/gross-margin-legacy");
    const withDeprecated = svc.search(all, { bundle: "acme_retail", query: "gross margin", status: ["deprecated"] });
    expect(withDeprecated.hits.map((h) => h.concept_id)).toEqual(["metrics/gross-margin-legacy"]);
  });

  it("filters without a query and pages with cursors", () => {
    const first = svc.search(all, { type: "metric", limit: 1 });
    expect(first.hits).toHaveLength(1);
    expect(first.next_cursor).toBeDefined();
    const second = svc.search(all, { type: "metric", limit: 1, cursor: first.next_cursor });
    expect(second.hits[0]?.concept_id).not.toBe(first.hits[0]?.concept_id);
    expect(svc.search(all, { bundle: "acme_retail", min_trust: "human-reviewed" }).hits.every((h) => h.trust_tier === "human-reviewed")).toBe(true);
    expect(svc.search(all, { bundle: "acme_retail", tags: ["finance", "margin"] }).hits.length).toBeGreaterThan(0);
  });

  it("searches raw sources only on request and finds unprocessed ones", () => {
    const raw = "\nรายงานประจำปีของ ACME ดาวเทียมธีออส-2 ถ่ายภาพได้ทุกวัน\n";
    const provider = new MemoryProvider().set("K", new Map([
      ["references/raw/report.md", renderNewConcept({ type: "Raw Source", title: "Annual report", language: "th", resource: "https://x", content_sha256: rawContentHash(raw) }, raw)],
      ["references/raw/other.md", renderNewConcept({ type: "Raw Source", title: "Other", language: "th", resource: "https://y" }, "\nข้อมูลอื่น\n")],
      ["concepts/theos-2.md", renderNewConcept({ type: "Satellite", title: "THEOS-2", aliases: ["ธีออส-2"], sources: [{ id: "r", resource: "/references/raw/report.md" }] }, "Daily imaging.[^r]\n\n[^r]: Report\n")],
    ]));
    const s = new KnowledgeService(provider, NOW);
    expect(s.search(all, { query: "ดาวเทียม" }).hits.map((h) => h.concept_id)).toEqual([]);
    expect(s.search(all, { query: "ธีออส" }).hits[0]?.concept_id).toBe("concepts/theos-2");
    expect(s.search(all, { query: "ถ่ายภาพ", include_raw: true }).hits[0]?.concept_id).toBe("references/raw/report");
    expect(s.search(all, { unprocessed_raw: true }).hits.map((h) => h.concept_id)).toEqual(["references/raw/other"]);
    expect(s.search(all, { language: "th", include_raw: true }).hits).toHaveLength(2);
  });

  it("refreshes its index when the bundle version changes", () => {
    const provider = new MemoryProvider().set("K", new Map([["a.md", "---\ntype: N\ntitle: Alpha\n---\n"]]));
    const s = new KnowledgeService(provider, NOW);
    expect(s.search(all, { query: "alpha" }).hits).toHaveLength(1);
    provider.set("K", new Map([["a.md", "---\ntype: N\ntitle: Beta\n---\n"]]));
    expect(s.search(all, { query: "alpha" }).hits).toHaveLength(0);
    expect(s.search(all, { query: "beta" }).hits).toHaveLength(1);
  });
});

describe("graph, lint, history", () => {
  it("walks the graph in both directions with typed edges", () => {
    const g = svc.graph(all, { bundle: "acme_retail", concept_id: "policies/revenue-recognition", depth: 1 });
    expect(g.edges.some((e) => e.kind === "source" && e.to === "policies/revenue-recognition")).toBe(true);
    expect(g.nodes.map((n) => n.concept_id)).toContain("computations/revenue-ytd");
  });

  it("filters lint by concept and severity", () => {
    const l = svc.lint(all, { bundle: "acme_retail", min_severity: "warning" });
    expect(l.counts).toMatchObject({ error: 0, info: 0 });
    expect(l.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    const one = svc.lint(all, { bundle: "acme_retail", concept_id: "policies/margin-standard" });
    expect(one.diagnostics.every((d) => d.path === "policies/margin-standard.md")).toBe(true);
  });

  it("reads history from log.md", () => {
    const h = svc.history(all, { bundle: "acme_retail", since: "2026-06-01" });
    expect(h.entries.map((e) => e.date)).toEqual(["2026-07-01", "2026-06-30"]);
    expect(err(() => svc.history(all, { bundle: "acme_retail", since: "June" })).code).toBe("invalid-argument");
  });
});

describe("path allowlists never leak", () => {
  const scoped = principal({ bundles: ["acme_retail"], pathPrefixes: ["metrics"] });

  it("hides concepts, backlinks, graph nodes and lint outside the prefix", () => {
    expect(err(() => svc.read(scoped, { concept_id: "policies/margin-standard" })).code).toBe("not-found");
    const r = svc.read(scoped, { concept_id: "metrics/gross-margin" });
    expect(r.links.backlinks.every((b) => b.concept_id.startsWith("metrics/"))).toBe(true);
    expect(r.sources.every((s) => !("resolved_concept_id" in s) || String(s.resolved_concept_id).startsWith("metrics/"))).toBe(true);
    const g = svc.graph(scoped, { concept_id: "metrics/gross-margin", depth: 2 });
    expect(g.nodes.every((n) => n.concept_id.startsWith("metrics/"))).toBe(true);
    expect(svc.search(scoped, { query: "revenue" }).hits.every((h) => h.concept_id.startsWith("metrics/"))).toBe(true);
    expect(svc.lint(scoped, {}).diagnostics.every((d) => d.path.startsWith("metrics/"))).toBe(true);
    expect(svc.browse(scoped, {}).subdirectories.map((d) => d.dir)).toEqual(["metrics"]);
    expect(svc.listBundles(scoped).bundles[0]!.concepts).toBe(3);
  });

  it("reports not-ready while the vault is indexing and nothing is loaded", () => {
    const empty = new MemoryProvider();
    empty.isReady = false;
    expect(err(() => new KnowledgeService(empty).browse(all, {})).code).toBe("not-ready");
  });
});

describe("search index across versions", () => {
  const QUERIES = ["revenue", "gross margin", "orders", "ต้นฉบับ", "attested"];
  const EDITS: [string, string | null][] = [
    ["metrics/revenue.md", "---\ntype: Metric\ntitle: Turnover\ndescription: Renamed.\n---\n\nTurnover is gross sales.\n"],
    ["tables/orders.md", null],
    ["notes/new.md", "---\ntype: Note\ntitle: Gross margin notes\n---\n\nAttested margin notes.\n"],
    ["references/raw/r.md", "---\ntype: Raw Source\ntitle: Raw\nlanguage: th\nresource: x\n---\n\nต้นฉบับ revenue\n"],
    [".okf.yaml", 'okf_version: "0.2"\nraw_dirs: [references/raw, notes]\n'],
    ["notes/new.md", null],
  ];

  it("updated in place gives the same results as one built from scratch", () => {
    const provider = fixtureProvider("acme_retail");
    const kept = new KnowledgeService(provider, NOW);
    const search = (s: KnowledgeService, query: string) => [
      s.search(all, { query }).hits.map((r) => `${r.concept_id}:${r.score}`),
      s.search(all, { query, include_raw: true }).hits.map((r) => `${r.concept_id}:${r.score}`),
    ];
    for (const q of QUERIES) search(kept, q);
    EDITS.forEach(([path, text], i) => {
      provider.applyLocal("acme_retail", new Map([[path, text]]));
      // Search only every other version, so a carried index also spans two versions.
      if (i % 2 === 0) return;
      const fresh = new KnowledgeService(provider, NOW);
      for (const q of QUERIES) expect(search(kept, q), `${q} after ${path}`).toEqual(search(fresh, q));
    });
  });
});

describe("warm", () => {
  it("builds the search index and lint cache in slices with the same results", async () => {
    const provider = fixtureProvider("acme_retail");
    const warmed = new KnowledgeService(provider, NOW);
    let pauses = 0;
    await warmed.warm(async () => void pauses++, 0);
    expect(pauses).toBeGreaterThan(0);
    const fresh = new KnowledgeService(provider, NOW);
    for (const query of ["revenue", "gross margin", "orders"]) {
      expect(warmed.search(all, { query })).toEqual(fresh.search(all, { query }));
    }
    expect(warmed.lint(all, { bundle: "acme_retail" })).toEqual(fresh.lint(all, { bundle: "acme_retail" }));
  });

  it("does not install an index built for a version that changed meanwhile", async () => {
    const provider = fixtureProvider("acme_retail");
    const svc = new KnowledgeService(provider, NOW);
    let changed = false;
    await svc.warm(async () => {
      if (changed) return;
      changed = true;
      provider.applyLocal("acme_retail", new Map([["notes/new.md", "---\ntype: Note\ntitle: Brand new revenue note\n---\n\nRevenue.\n"]]));
    }, 0);
    expect(svc.search(all, { query: "brand new" }).hits.map((h) => h.concept_id)).toContain("notes/new");
  });
});

describe("readFile", () => {
  const files = () => {
    const p = fixtureProvider("acme_retail");
    p.applyLocal("acme_retail", new Map([["images/logo.png", "PNG"], [".git/config", "secret"]]));
    return p;
  };

  it("reads a non-markdown text file, paged", async () => {
    const svc = new KnowledgeService(files(), NOW);
    const r = await svc.readFile(all, { bundle: "acme_retail", path: "attesters/sql_equality.py", max_chars: 100 });
    expect(r.text).toContain("Copyright 2026 Google LLC");
    expect(r).toMatchObject({ path: "attesters/sql_equality.py", offset: 0, truncated: true, next_offset: 100 });
    const next = await svc.readFile(all, { bundle: "acme_retail", path: "/attesters/sql_equality.py", offset: r.next_offset });
    expect(next.offset).toBe(100);
  });

  it("refuses markdown, binaries, hidden and outside paths, and honours the token's path scope", async () => {
    const svc = new KnowledgeService(files(), NOW);
    const code = async (args: { path: string }, p = all) => {
      try {
        await svc.readFile(p, { bundle: "acme_retail", ...args });
        return "ok";
      } catch (e) {
        return (e as ServiceError).code;
      }
    };
    expect(await code({ path: "metrics/revenue.md" })).toBe("invalid-argument");
    expect(await code({ path: "images/logo.png" })).toBe("invalid-argument");
    expect(await code({ path: ".git/config" })).toBe("not-found");
    expect(await code({ path: "../outside.py" })).toBe("invalid-argument");
    expect(await code({ path: "attesters/missing.py" })).toBe("not-found");
    expect(await code({ path: "attesters/sql_equality.py" }, principal({ pathPrefixes: ["metrics"] }))).toBe("not-found");
  });

  it("points okf_read at okf_read_file when asked for a file", () => {
    const svc = new KnowledgeService(files(), NOW);
    expect(err(() => svc.read(all, { bundle: "acme_retail", concept_id: "attesters/sql_equality.py" })).hint).toMatch(/okf_read_file/);
  });
});
