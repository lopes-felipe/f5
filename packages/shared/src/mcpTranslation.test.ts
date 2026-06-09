import { describe, expect, it } from "vitest";
import {
  CodexMcpOAuthCallbackPortConflictError,
  readCodexMcpOAuthCallbackPort,
  translateMcpForClaudeAgent,
  translateMcpForCodex,
} from "./mcpTranslation";

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
          oauthClientId: "client-1",
          oauthCallbackPort: 3118,
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
        oauth: {
          client_id: "client-1",
        },
        oauth_resource: "example",
      },
    });
  });

  it("reads the shared enabled Codex OAuth callback port", () => {
    expect(
      readCodexMcpOAuthCallbackPort({
        disabled: {
          type: "http",
          enabled: false,
          url: "https://disabled.example.test/mcp",
          oauthCallbackPort: 1234,
        },
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackPort: 3118,
        },
        alsoSlack: {
          type: "http",
          url: "https://mcp2.slack.com/mcp",
          oauthCallbackPort: 3118,
        },
      }),
    ).toBe(3118);
  });

  it("rejects conflicting enabled Codex OAuth callback ports", () => {
    expect(() =>
      readCodexMcpOAuthCallbackPort({
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackPort: 3118,
        },
        observability: {
          type: "http",
          url: "https://observability.example.test/mcp",
          oauthCallbackPort: 4118,
        },
      }),
    ).toThrow(CodexMcpOAuthCallbackPortConflictError);
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
