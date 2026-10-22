import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/buildServer";
import { KnowledgeService } from "../../src/service/knowledgeService";
import type { Principal } from "../../src/service/types";
import { fixtureProvider, principal } from "../helpers-service";

const service = new KnowledgeService(fixtureProvider("acme_retail", "ga4"), () => new Date("2026-10-14T00:00:00Z"));

async function connect(p: Principal): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(service, p, { version: "test" });
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

describe("MCP surface", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(principal());
  });
  afterAll(async () => {
    await client.close();
  });

  it("lists the read tools with read-only annotations and instructions", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["okf_browse", "okf_bundles", "okf_graph", "okf_history", "okf_lint", "okf_read", "okf_read_file", "okf_search"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.outputSchema)).toBe(true);
    expect(client.getInstructions()).toMatch(/okf_bundles/);
  });

  it("returns structured content that matches the text", async () => {
    const r = await client.callTool({ name: "okf_read", arguments: { bundle: "acme_retail", concept_id: "metrics/revenue", view: "outline" } });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc["concept_id"]).toBe("metrics/revenue");
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual(sc);
  });

  it("accepts a heading path sent as JSON text", async () => {
    const r = await client.callTool({
      name: "okf_read",
      arguments: { bundle: "acme_retail", concept_id: "metrics/gross-margin", view: "section", section: '["Definition"]' },
    });
    expect((r.structuredContent as { body: string }).body.startsWith("# Definition")).toBe(true);
  });

  it("reports service errors with a code and hint, not an exception", async () => {
    const r = await client.callTool({ name: "okf_read", arguments: { concept_id: "metrics/revenue" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/\[ambiguous\][\s\S]*Hint: Pass `bundle`/);
  });

  it("rejects invalid arguments through the schema", async () => {
    const r = await client.callTool({ name: "okf_search", arguments: { limit: 1000 } });
    expect(r.isError).toBe(true);
  });

  it("serves resources: spec, status, bundle index and concept text", async () => {
    const list = await client.listResources();
    expect(list.resources.map((r) => r.uri)).toEqual(expect.arrayContaining(["okf://spec", "okf://status", "okf://bundles/acme_retail/index"]));
    const spec = await client.readResource({ uri: "okf://spec" });
    expect((spec.contents[0] as { text: string }).text).toMatch(/OKF v0.2/);
    const idx = await client.readResource({ uri: "okf://bundles/acme_retail/index" });
    expect((idx.contents[0] as { text: string }).text).toMatch(/# Subdirectories/);
    const concept = await client.readResource({ uri: "okf://bundles/acme_retail/concepts/metrics/revenue" });
    expect((concept.contents[0] as { text: string }).text).toMatch(/^---\ntype: Metric/);
  });
});

describe("scopes", () => {
  it("offers no tools to a token without the read scope", async () => {
    const c = await connect(principal({ scopes: new Set() }));
    expect((await c.listTools()).tools).toEqual([]);
    await c.close();
  });

  it("gives a path-scoped token a filtered bundle index", async () => {
    const c = await connect(principal({ bundles: ["acme_retail"], pathPrefixes: ["metrics"] }));
    const idx = await c.readResource({ uri: "okf://bundles/acme_retail/index" });
    const text = (idx.contents[0] as { text: string }).text;
    expect(text).toMatch(/metrics/);
    expect(text).not.toMatch(/policies/);
    await c.close();
  });
});
