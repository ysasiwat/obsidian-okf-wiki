import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { parseConcept } from "../../src/core/document";
import { buildMcpServer } from "../../src/mcp/buildServer";
import { KnowledgeService } from "../../src/service/knowledgeService";
import type { Principal, Scope } from "../../src/service/types";
import { WriteService } from "../../src/service/writeService";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../helpers-service";

const NOW = new Date("2026-10-19T08:00:00Z");

async function connect(scopes: Scope[], over: Partial<Principal> = {}) {
  const provider = new MemoryProvider().set("K", new Map([[".okf.yaml", 'okf_version: "0.2"\n']]));
  const writes = new WriteService(provider, new MemoryFilePort(provider), new MemorySnapshots(), new MemoryAudit(), { now: () => NOW });
  const knowledge = new KnowledgeService(provider, () => NOW);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(knowledge, principal({ tokenName: "claude-code", scopes: new Set(scopes), ...over }), { version: "test", writes }).connect(st);
  const client = new Client({ name: "test-client", version: "9.9" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { client, call, provider };
}

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe("write tools", () => {
  it("are offered by scope", async () => {
    const names = async (s: Scope[]) => (await (await connect(s)).client.listTools()).tools.map((t) => t.name);
    expect(await names(["read"])).not.toContain("okf_create");
    const writer = await names(["read", "write"]);
    expect(writer).toEqual(expect.arrayContaining(["okf_create", "okf_update", "okf_ingest_raw", "okf_move", "okf_deprecate", "okf_describe_directory"]));
    expect(writer).not.toContain("okf_publish");
    expect(writer).toContain("okf_request_review");
    expect(writer).not.toContain("okf_verify");
    expect(await names(["read", "write", "publish"])).toContain("okf_publish");
    expect(await names(["read", "write", "verify"])).toContain("okf_verify");
  });

  it("create, read, update round trip with the client version as actor", async () => {
    const { call, provider } = await connect(["read", "write"]);
    const created = await call("okf_create", {
      concept_id: "concepts/remote-sensing",
      frontmatter: { type: "Concept", title: "Remote sensing", description: "Observing Earth from a distance." },
      body: "Remote sensing observes Earth.\n",
    });
    expect(created.isError).toBeFalsy();
    const read = (await call("okf_read", { concept_id: "concepts/remote-sensing", view: "frontmatter" })).structuredContent as { etag: string; frontmatter: Record<string, unknown> };
    expect(read.frontmatter["generated"]).toEqual({ by: "claude-code/9.9", at: "2026-10-19T08:00:00Z" });
    const updated = await call("okf_update", {
      concept_id: "concepts/remote-sensing",
      if_match: read.etag,
      reason: "Add an example.",
      tags_add: ["eo"],
      body_ops: [{ op: "append", content: "## Example\n\nFlood mapping." }],
      actor_version: "opus-5.5",
    });
    expect(updated.isError).toBeFalsy();
    const fm = parseConcept(provider.files.get("K")!.get("concepts/remote-sensing.md")!).frontmatter;
    expect(fm).toMatchObject({ tags: ["eo"], generated: { by: "claude-code/opus-5.5" } });
  });

  it("reports conflicts with the current etag in the error data", async () => {
    const { call } = await connect(["read", "write"]);
    await call("okf_create", { concept_id: "a", frontmatter: { type: "Note" }, body: "Hello.\n" });
    const r = await call("okf_update", { concept_id: "a", if_match: "0".repeat(64), reason: "x", tags_add: ["t"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^\[conflict\][\s\S]*Hint: Read it again[\s\S]*Data: \{"etag":"[0-9a-f]{64}"\}/);
  });

  it("ingests raw material and refuses invalid body ops through the schema", async () => {
    const { call } = await connect(["read", "write"]);
    const raw = await call("okf_ingest_raw", { slug: "report", title: "Report", description: "Original report.", language: "th", resource: "https://x", body: "รายงานต้นฉบับ\n" });
    expect((raw.structuredContent as { concept_id: string }).concept_id).toBe("references/raw/report");
    const bad = await call("okf_update", { concept_id: "references/raw/report", if_match: "x", reason: "x", body_ops: [{ op: "explode" }] });
    expect(bad.isError).toBe(true);
  });

  it("stamps process tokens as process actors", async () => {
    const { call, provider } = await connect(["read", "write"], { kind: "process", tokenName: "nightly" });
    await call("okf_create", { concept_id: "a", frontmatter: { type: "Note" }, body: "Hello.\n" });
    expect(parseConcept(provider.files.get("K")!.get("a.md")!).frontmatter["generated"]).toMatchObject({ by: "process:nightly" });
  });

  it("serves the authoring prompts", async () => {
    const { client } = await connect(["read", "write"]);
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(["okf_author_concept", "okf_distill_raw"]);
    const p = await client.getPrompt({ name: "okf_distill_raw", arguments: { raw_concept_id: "references/raw/report" } });
    expect((p.messages[0]!.content as { text: string }).text).toMatch(/resource: "\/references\/raw\/report.md"/);
  });
});
