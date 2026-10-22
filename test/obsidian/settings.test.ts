import { describe, expect, it } from "vitest";
import { clientSnippets, DEFAULT_SETTINGS, sanitizeSettings } from "../../src/obsidian/settings";
import { createTokenRecord } from "../../src/server/tokens";

describe("sanitizeSettings", () => {
  it("returns defaults for missing or malformed data", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ port: 80, serverEnabled: "yes" })).toMatchObject({ port: DEFAULT_SETTINGS.port, serverEnabled: true });
  });

  it("keeps valid tokens and bundles and drops malformed ones", () => {
    const { record } = createTokenRecord({ name: "claude-code" });
    const s = sanitizeSettings({
      port: 28000,
      bundles: [{ path: "Knowledge" }, { path: "Old", enabled: false }, { nope: 1 }, null],
      tokens: [record, { ...record, hash: "not-a-hash" }, { name: "x" }, { ...record, scopes: ["read", "root"] }],
    });
    expect(s.port).toBe(28000);
    expect(s.bundles).toEqual([{ path: "Knowledge", enabled: true }, { path: "Old", enabled: false }]);
    expect(s.tokens).toHaveLength(2);
    expect(s.tokens[1]!.scopes).toEqual(["read"]);
  });

  it("never stores a plaintext token in settings", () => {
    const { token, record } = createTokenRecord({ name: "a" });
    expect(JSON.stringify(sanitizeSettings({ tokens: [record] }))).not.toContain(token);
  });
});

describe("clientSnippets", () => {
  it("builds Claude Code and .mcp.json configuration", () => {
    const s = clientSnippets(27150, "okf_abc");
    expect(s.claudeCode).toBe('claude mcp add --transport http okf-wiki http://127.0.0.1:27150/mcp/ --header "Authorization: Bearer okf_abc"');
    expect(JSON.parse(s.mcpJson).mcpServers["okf-wiki"]).toEqual({
      type: "http", url: "http://127.0.0.1:27150/mcp/", headers: { Authorization: "Bearer okf_abc" },
    });
  });
});
