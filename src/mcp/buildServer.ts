// The MCP surface (DESIGN.md §7): read tools, resources and instructions for one caller.
// A server is built per request (2026-07-28) or per session (older revisions), always for
// a single authenticated principal, so tools never see another token's view.

import { McpServer, ResourceTemplate, type CallToolResult, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { KnowledgeService, MAX_LIMIT, MAX_READ_CHARS, TEXT_FILE_EXTENSIONS } from "../service/knowledgeService";
import type { Principal } from "../service/types";
import type { WriteService } from "../service/writeService";
import { run as runTool, runAsync } from "./results";
import { OKF_SPEC_SUMMARY, SERVER_INSTRUCTIONS } from "./texts";
import { registerWriteTools } from "./writeTools";

export { MAX_RESULT_CHARS } from "./results";
export const SERVER_NAME = "obsidian-okf-wiki";

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const bundleArg = z.string().optional().describe("Bundle name from okf_bundles. Optional when the token can see exactly one bundle.");
const conceptIdArg = z.string().describe("Concept id: the bundle-relative path without .md, e.g. 'metrics/revenue'.");
const limitArg = z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Page size (default 20, max ${MAX_LIMIT}).`);
const cursorArg = z.string().optional().describe("next_cursor from the previous page.");
const status = z.enum(["draft", "stable", "deprecated"]);
const trust = z.enum(["unverified", "machine-confirmed", "human-reviewed"]);

/**
 * Some MCP clients send an array argument as its JSON text. Accept both forms for
 * heading paths, as obsidian-local-rest-api learned to (its issue #315).
 */
const headingPath = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || Array.isArray(v)) return v;
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
    } catch {
      // fall through
    }
    return [v];
  })
  .describe('Heading path for view "section", from the top level down, e.g. ["Schema"] or ["Definition", "Examples"].');

const conceptSummary = z.looseObject({
  concept_id: z.string(),
  title: z.string(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  trust_tier: z.string(),
  stale: z.boolean(),
  zone: z.string(),
});

export interface BuildOptions {
  version: string;
  /** Present when writes are enabled; write tools are offered to tokens with the write scope. */
  writes?: WriteService;
  onError?: (error: unknown) => void;
}

export function buildMcpServer(service: KnowledgeService, principal: Principal, options: BuildOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  const run = (fn: () => object): CallToolResult => runTool(fn, options.onError);

  if (principal.scopes.has("read")) {
    server.registerTool(
      "okf_bundles",
      {
        title: "List bundles",
        description: "List the OKF bundles this token can read, with concept counts by type, status, trust tier and zone, and lint totals. Start here.",
        inputSchema: z.object({}),
        outputSchema: z.looseObject({ ready: z.boolean(), bundles: z.array(z.looseObject({ name: z.string(), concepts: z.number() })) }),
        annotations: READ_ONLY,
      },
      async () => run(() => service.listBundles(principal)),
    );

    server.registerTool(
      "okf_browse",
      {
        title: "Browse a directory",
        description: "List one directory of a bundle: subdirectories (with descriptions and concept counts), concepts (title, type, description, status, trust, staleness) and other files. Use it to explore a bundle level by level.",
        inputSchema: z.object({ bundle: bundleArg, dir: z.string().optional().describe("Directory inside the bundle; omit for the bundle root.") }),
        outputSchema: z.looseObject({ bundle: z.string(), dir: z.string(), subdirectories: z.array(z.looseObject({ dir: z.string() })), concepts: z.array(conceptSummary), files: z.array(z.string()) }),
        annotations: READ_ONLY,
      },
      async (args) => run(() => service.browse(principal, args)),
    );

    server.registerTool(
      "okf_read",
      {
        title: "Read a concept",
        description:
          'Read a concept. view "full" (default) returns frontmatter and body; "outline" returns the heading tree, footnotes and sources without the body; "frontmatter" returns metadata only; "section" returns one heading\'s section. Long bodies are paged: pass next_offset as offset. Every view reports etag, trust_tier, status, stale, verification_outdated, links (outgoing, backlinks, broken) and sources resolved to concept ids. For long concepts, read the outline first.',
        inputSchema: z.object({
          concept_id: conceptIdArg,
          bundle: bundleArg,
          view: z.enum(["full", "outline", "frontmatter", "section"]).optional(),
          section: headingPath,
          offset: z.number().int().min(0).optional().describe("Character offset into the body or section."),
          max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional().describe(`Characters to return (default 20000, max ${MAX_READ_CHARS}).`),
        }),
        outputSchema: conceptSummary.extend({ bundle: z.string(), etag: z.string(), view: z.string() }),
        annotations: READ_ONLY,
      },
      async (args) => run(() => service.read(principal, args)),
    );

    server.registerTool(
      "okf_read_file",
      {
        title: "Read a non-markdown file",
        description:
          `Read a text file in a bundle that is not a concept, such as an attester's or executor's code (attesters/sql_equality.py) or a data sample. Paths are bundle-relative; okf_browse lists them. Only text files (${TEXT_FILE_EXTENSIONS.join(" ")}); markdown files are concepts, read them with okf_read. Long files are paged: pass next_offset as offset.`,
        inputSchema: z.object({
          path: z.string().describe("Bundle-relative path, e.g. 'attesters/sql_equality.py'."),
          bundle: bundleArg,
          offset: z.number().int().min(0).optional().describe("Character offset into the file."),
          max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional().describe(`Characters to return (default 20000, max ${MAX_READ_CHARS}).`),
        }),
        outputSchema: z.object({
          bundle: z.string(),
          path: z.string(),
          text: z.string(),
          offset: z.number(),
          total_chars: z.number(),
          truncated: z.boolean(),
          next_offset: z.number().optional(),
        }),
        annotations: READ_ONLY,
      },
      async (args) => runAsync(() => service.readFile(principal, args), options.onError),
    );

    server.registerTool(
      "okf_search",
      {
        title: "Search concepts",
        description:
          "Full-text search (BM25 over title, aliases, tags, description, body) with filters, or a filtered listing when query is omitted. By default searches curated concepts only, excludes deprecated ones, and flags stale ones. include_raw adds original-language raw sources; unprocessed_raw lists raw sources no curated concept cites yet.",
        inputSchema: z.object({
          query: z.string().optional(),
          bundle: z.string().optional().describe("Limit to one bundle; omit to search every bundle the token can read."),
          type: z.string().optional().describe("Exact concept type, case-insensitive."),
          tags: z.array(z.string()).optional().describe("Concepts must have all of these tags."),
          status: z.array(status).optional().describe('Statuses to include (default ["draft", "stable"]).'),
          min_trust: trust.optional(),
          stale: z.boolean().optional().describe("true: only stale concepts; false: only fresh ones."),
          under: z.string().optional().describe("Only concepts under this directory."),
          include_raw: z.boolean().optional(),
          unprocessed_raw: z.boolean().optional(),
          language: z.string().optional().describe("BCP 47 language of the concept, e.g. 'th' for Thai raw sources."),
          limit: limitArg,
          cursor: cursorArg,
        }),
        outputSchema: z.looseObject({ hits: z.array(conceptSummary.extend({ bundle: z.string(), score: z.number(), snippet: z.string() })), total: z.number() }),
        annotations: READ_ONLY,
      },
      async (args) => run(() => service.search(principal, args)),
    );

    server.registerTool(
      "okf_graph",
      {
        title: "Concept neighbourhood",
        description: "Concepts linked to and from a concept, up to depth 2. Edge kinds: link (body link), source (sources[].resource), resource, computation, executor, attester.",
        inputSchema: z.object({
          concept_id: conceptIdArg,
          bundle: bundleArg,
          depth: z.number().int().min(1).max(2).optional(),
          direction: z.enum(["out", "in", "both"]).optional(),
        }),
        outputSchema: z.looseObject({ center: z.string(), nodes: z.array(conceptSummary), edges: z.array(z.looseObject({ from: z.string(), to: z.string(), kind: z.string() })) }),
        annotations: READ_ONLY,
      },
      async (args) => run(() => service.graph(principal, args)),
    );

    server.registerTool(
      "okf_lint",
      {
        title: "Lint a bundle",
        description: "OKF conformance and quality diagnostics (error, warning, info) for a bundle or one concept, each with a code and a fix hint.",
        inputSchema: z.object({
          bundle: bundleArg,
          concept_id: conceptIdArg.optional(),
          min_severity: z.enum(["error", "warning", "info"]).optional().describe("Lowest severity to include (default info)."),
          limit: limitArg,
          cursor: cursorArg,
        }),
        outputSchema: z.looseObject({ counts: z.looseObject({ error: z.number(), warning: z.number(), info: z.number() }), diagnostics: z.array(z.looseObject({ code: z.string(), severity: z.string(), path: z.string() })) }),
        annotations: READ_ONLY,
      },
      async (args) => run(() => service.lint(principal, args)),
    );

    server.registerTool(
      "okf_history",
      {
        title: "Change history",
        description: "Entries from the bundle's log.md, newest first: what changed, why, and by whom. Filter by concept or by date.",
        inputSchema: z.object({
          bundle: bundleArg,
          concept_id: conceptIdArg.optional(),
          since: z.string().optional().describe("Only entries on or after this UTC date, YYYY-MM-DD."),
          limit: limitArg,
          cursor: cursorArg,
        }),
        outputSchema: z.looseObject({ entries: z.array(z.looseObject({ date: z.string(), text: z.string() })), total: z.number() }),
        annotations: READ_ONLY,
      },
      async (args) => run(() => service.history(principal, args)),
    );

    registerResources(server, service, principal);
  }

  if (options.writes) registerWriteTools(server, options.writes, principal, { ...(options.onError ? { onError: options.onError } : {}) });
  return server;
}

/** okf://spec, okf://status, okf://bundles/{bundle}/index, okf://bundles/{bundle}/concepts/{+concept_id}. */
function registerResources(server: McpServer, service: KnowledgeService, principal: Principal): void {
  server.registerResource("okf-spec", "okf://spec", { title: "OKF v0.2 summary", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: OKF_SPEC_SUMMARY }],
  }));

  server.registerResource("okf-status", "okf://status", { title: "Server status", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(service.status(principal)) }],
  }));

  const decode = (v: string | string[] | undefined) => decodeURIComponent(Array.isArray(v) ? v.join("/") : (v ?? ""));

  server.registerResource(
    "okf-bundle-index",
    new ResourceTemplate("okf://bundles/{bundle}/index", {
      list: async () => ({
        resources: service.listBundles(principal).bundles.map((b) => ({
          uri: `okf://bundles/${encodeURIComponent(b.name)}/index`,
          name: `${b.name} index`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    { title: "Bundle index", mimeType: "text/markdown" },
    async (uri, vars) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: service.indexMarkdown(principal, decode(vars["bundle"])) }],
    }),
  );

  server.registerResource(
    "okf-concept",
    new ResourceTemplate("okf://bundles/{bundle}/concepts/{+concept_id}", { list: undefined }),
    { title: "Concept source", mimeType: "text/markdown" },
    async (uri, vars) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: service.conceptText(principal, decode(vars["bundle"]), decode(vars["concept_id"])).text }],
    }),
  );
}
