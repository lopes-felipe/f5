import { describe, it, expect } from "vitest";
import { parseMcpImport, parseImportedServers } from "./mcpImport";
import { computeEffectiveMcpConfigVersion, mergeMcpServerLayers } from "./mcpConfig";
import { mcpToolSwitchState, setMcpToolEnabled, summarizeMcpTools } from "./mcpTools";
import { mcpSecretId, validateMcpSecretPlaceholders } from "./mcpSecrets";

describe("MCP feature data", () => {
  it("finds no pasted servers in Codex TOML without an MCP section", () => {
    expect(parseMcpImport('model="gpt-5"\n[projects."/tmp"]\ntrust_level="trusted"')).toEqual({
      candidates: [],
      issues: [],
    });
    expect(parseMcpImport('{"local":{"command":"node"}}').candidates).toHaveLength(1);
  });
  it("keeps opt-outs after a case-only common-server rename", () => {
    expect(
      mergeMcpServerLayers({
        common: { GitHub: { type: "stdio", command: "node" } },
        disabledCommon: ["github"],
      }).GitHub?.enabled,
    ).toBe(false);
  });
  it("imports lossless TOML with inline tables, multiline strings, arrays, and OAuth inheritance", () => {
    const parsed = parseMcpImport(`mcp_oauth_callback_port = 3140
[mcp_servers.remote]
url = "http://localhost/mcp"
http_headers = { Authorization = "a-long-token" }
enabled = false
supports_parallel_tool_calls = false
tool_timeout_sec = 0
enabled_tools = []
[mcp_servers.local]
command = "node"
args = [
  "", "  spaced  ",
  """first
second"""
]
env = { TEST = "first\\nsecond" }
`);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]?.server).toMatchObject({
      enabled: false,
      supportsParallelToolCalls: false,
      toolTimeoutSec: 0,
      enabledTools: [],
      oauthCallbackPort: 3140,
      headers: { Authorization: "a-long-token" },
    });
    expect(parsed.candidates[1]?.server?.args).toEqual(["", "  spaced  ", "first\nsecond"]);
    expect(parsed.candidates.flatMap((entry) => entry.issues)).toEqual([]);
  });
  it("keeps invalid and SDK candidates and reports unsupported authentication fields", () => {
    const parsed = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://example.com",
            env_http_headers: { Authorization: "TOKEN" },
            bearer_token: "token",
            auth: { unsupported: true },
          },
          sdk: { type: "sdk" },
          invalid: { type: "http", url: "file:///bad", enabled: 1 },
        },
      }),
    );
    expect(parsed.candidates).toHaveLength(3);
    expect(parsed.candidates[0]?.issues.map((issue) => issue.field)).toEqual([
      "env_http_headers",
      "bearer_token",
      "auth",
    ]);
    expect(parsed.candidates[1]?.issues[0]).toMatchObject({ field: "type", severity: "error" });
    expect(parsed.candidates[2]?.issues).toContainEqual(
      expect.objectContaining({ field: "url", severity: "error" }),
    );
  });
  it("rejects imported secret placeholders in either parser", () => {
    const text = JSON.stringify({
      mcpServers: {
        local: {
          command: "node",
          env: { TOKEN: "${f5-secret:00000000-0000-4000-8000-000000000000}" },
        },
      },
    });
    expect(
      parseMcpImport(text).candidates[0]?.issues.some((issue) => issue.severity === "error"),
    ).toBe(true);
    expect(() => parseImportedServers(text)).toThrow("placeholders");
  });
  it("project opt-outs change the effective version while exact project overrides win", () => {
    const common = { local: { type: "stdio" as const, command: "node" } };
    const disabled = mergeMcpServerLayers({ common, disabledCommon: ["local"] });
    expect(disabled.local?.enabled).toBe(false);
    expect(computeEffectiveMcpConfigVersion(disabled)).not.toBe(
      computeEffectiveMcpConfigVersion(common),
    );
    expect(mergeMcpServerLayers({ common, disabledCommon: ["local"], project: common })).toEqual(
      common,
    );
  });
  it("switches edit the denylist and retain allowlists including legacy empty lists", () => {
    const server = {
      type: "stdio" as const,
      command: "node",
      enabledTools: ["allowed"],
      disabledTools: ["allowed"],
    };
    expect(mcpToolSwitchState(server, "allowed")).toEqual({ checked: false, excluded: false });
    expect(mcpToolSwitchState(server, "other")).toEqual({ checked: false, excluded: true });
    const on = setMcpToolEnabled(server, "allowed", true);
    expect(on).toMatchObject({ enabledTools: ["allowed"], disabledTools: [] });
    expect(setMcpToolEnabled(on, "allowed", false)).toEqual(server);
    expect(setMcpToolEnabled({ type: "stdio", command: "node" }, "x", true)).not.toHaveProperty(
      "enabledTools",
    );
  });
  it("bounds tool summaries and validates whole-value secret references", () => {
    expect(
      summarizeMcpTools(
        Array.from({ length: 201 }, (_, i) => ({
          name: `tool${i}`,
          description: "a".repeat(400),
          annotations: { readOnlyHint: true },
        })),
      ),
    ).toHaveLength(200);
    expect(
      summarizeMcpTools([{ name: "tool", description: "a".repeat(400) }])[0]?.description,
    ).toHaveLength(300);
    const placeholder = "${f5-secret:00000000-0000-4000-8000-000000000000}";
    expect(mcpSecretId(placeholder)).toBeDefined();
    expect(() =>
      validateMcpSecretPlaceholders({
        local: { type: "stdio", command: "node", env: { TOKEN: `prefix${placeholder}` } },
      }),
    ).toThrow("entire value");
    expect(() =>
      validateMcpSecretPlaceholders({
        local: { type: "stdio", command: "node", args: [placeholder] },
      }),
    ).toThrow("only in env");
  });
});
