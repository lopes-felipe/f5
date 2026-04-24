import { describe, expect, it } from "vitest";
import { translateMcpForClaudeAgent, translateMcpForCodex } from "./mcpTranslation";

describe("mcpTranslation", () => {
  it("filters disabled servers and drops Codex-only fields for Claude", () => {
    expect(
      translateMcpForClaudeAgent({
        alpha: {
          type: "stdio",
          enabled: true,
          command: "node",
          args: ["server.js"],
          supportsParallelToolCalls: true,
          startupTimeoutSec: 10,
        },
        beta: {
          type: "http",
          enabled: false,
          url: "https://example.com/mcp",
        },
      }),
    ).toEqual({
      alpha: {
        type: "stdio",
        command: "node",
        args: ["server.js"],
      },
    });
  });

  it("preserves advanced fields for Codex", () => {
    expect(
      translateMcpForCodex({
        alpha: {
          type: "http",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer token",
          },
          bearerTokenEnvVar: "MCP_TOKEN",
          enabledTools: ["search"],
          disabledTools: ["write"],
          scopes: ["repo:read"],
          oauthResource: "example",
        },
      }),
    ).toEqual({
      alpha: {
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer token",
        },
        bearer_token_env_var: "MCP_TOKEN",
        enabled_tools: ["search"],
        disabled_tools: ["write"],
        scopes: ["repo:read"],
        oauth_resource: "example",
      },
    });
  });

  it("returns undefined when no enabled valid servers remain", () => {
    expect(
      translateMcpForClaudeAgent({
        alpha: {
          type: "stdio",
          enabled: false,
          command: "node",
        },
        beta: {
          type: "http",
          url: "   ",
        },
      }),
    ).toBeUndefined();
  });
});
