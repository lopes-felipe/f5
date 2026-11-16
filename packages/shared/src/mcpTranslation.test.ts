import { describe, expect, it } from "vitest";
import {
  buildMcpToolFilters,
  claudeDisallowedMcpToolNames,
  evaluateMcpToolFilter,
  normalizeClaudeMcpName,
  CodexMcpOAuthCallbackPortConflictError,
  CodexMcpOAuthCallbackUrlConflictError,
  readCodexMcpOAuthCallbackConfig,
  readCodexMcpOAuthCallbackPort,
  readCodexMcpOAuthCallbackUrl,
  translateMcpForClaudeAgent,
  translateMcpForCodex,
} from "./mcpTranslation";

describe("mcpTranslation", () => {
  it.each(["http", "sse"] as const)("forwards Claude %s OAuth settings", (type) => {
    expect(
      translateMcpForClaudeAgent({
        slack: {
          type,
          url: "https://mcp.slack.com/mcp",
          oauthClientId: "1601185624273.8899143856786",
          oauthCallbackPort: 3118,
          scopes: ["search:read"],
          oauthCallbackUrl: "http://localhost:3118/callback",
          oauthResource: "slack",
        },
      }),
    ).toEqual({
      slack: {
        type,
        url: "https://mcp.slack.com/mcp",
        oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 },
      },
    });
  });

  it.each(["http", "sse"] as const)("forwards individual Claude %s OAuth settings", (type) => {
    for (const [settings, oauth] of [
      [{ oauthClientId: " client-1 " }, { clientId: "client-1" }],
      [{ oauthCallbackPort: 3118 }, { callbackPort: 3118 }],
    ] as const) {
      expect(
        translateMcpForClaudeAgent({
          server: { type, url: "https://example.test/mcp", ...settings },
        }),
      ).toEqual({ server: { type, url: "https://example.test/mcp", oauth } });
    }
  });

  it.each(["http", "sse"] as const)(
    "omits Claude %s OAuth when no settings are configured",
    (type) => {
      for (const settings of [{}, { oauthClientId: " \t " }]) {
        expect(
          translateMcpForClaudeAgent({
            server: { type, url: "https://example.test/mcp", ...settings },
          }),
        ).toEqual({ server: { type, url: "https://example.test/mcp" } });
      }
    },
  );

  it("omits OAuth settings for Claude stdio servers", () => {
    expect(
      translateMcpForClaudeAgent({
        server: {
          type: "stdio",
          command: "node",
          oauthClientId: "client-1",
          oauthCallbackPort: 3118,
        },
      }),
    ).toEqual({ server: { type: "stdio", command: "node" } });
  });

  it.each(["stdio", "http", "sse"] as const)(
    "translates Claude %s tool timeouts to milliseconds",
    (type) => {
      const server =
        type === "stdio"
          ? { type, command: "node", toolTimeoutSec: 45 }
          : {
              type,
              url: "https://example.test/mcp",
              toolTimeoutSec: 45,
              bearerTokenEnvVar: "TOKEN",
            };
      const translated = translateMcpForClaudeAgent({ server })!.server!;
      expect(translated.timeout).toBe(45_000);
      expect(translated).not.toHaveProperty("bearerTokenEnvVar");
      expect(translated).not.toHaveProperty("headers");
    },
  );

  it("leaves Claude's default timeout in effect for a saved zero", () => {
    expect(
      translateMcpForClaudeAgent({ server: { type: "stdio", command: "node", toolTimeoutSec: 0 } })!
        .server,
    ).not.toHaveProperty("timeout");
  });

  it("keeps SSE URLs unchanged for Codex", () => {
    expect(
      translateMcpForCodex({ server: { type: "sse", url: "https://example.test/sse" } }),
    ).toEqual({ server: { type: "sse", url: "https://example.test/sse" } });
  });

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
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
          oauthResource: "example",
        },
      }),
    ).toEqual({
      alpha: {
        type: "http",
        url: "https://example.com/mcp",
        http_headers: {
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

  it.each([{ enabledTools: [] }, { enabledTools: [" ", "\t"] }])(
    "treats an empty enabled-tools list as no allowlist: %j",
    ({ enabledTools }) => {
      expect(
        translateMcpForCodex({ shell: { type: "stdio", command: "node", enabledTools } })?.shell,
      ).not.toHaveProperty("enabled_tools");
    },
  );

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

  it("reads the shared enabled Codex OAuth callback URL", () => {
    expect(
      readCodexMcpOAuthCallbackUrl({
        disabled: {
          type: "http",
          enabled: false,
          url: "https://disabled.example.test/mcp",
          oauthCallbackUrl: "http://127.0.0.1:1234/callback",
        },
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
        alsoSlack: {
          type: "http",
          url: "https://mcp2.slack.com/mcp",
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
      }),
    ).toBe("http://127.0.0.1:3118/callback");
  });

  it("reads combined Codex OAuth callback config", () => {
    expect(
      readCodexMcpOAuthCallbackConfig({
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackPort: 3118,
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
      }),
    ).toEqual({
      port: 3118,
      url: "http://127.0.0.1:3118/callback",
    });
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

  it("does not reject URL conflicts when reading only the callback port", () => {
    expect(
      readCodexMcpOAuthCallbackPort({
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackPort: 3118,
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
        observability: {
          type: "http",
          url: "https://observability.example.test/mcp",
          oauthCallbackPort: 3118,
          oauthCallbackUrl: "http://127.0.0.1:4118/callback",
        },
      }),
    ).toBe(3118);
  });

  it("rejects conflicting enabled Codex OAuth callback URLs", () => {
    expect(() =>
      readCodexMcpOAuthCallbackUrl({
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
        observability: {
          type: "http",
          url: "https://observability.example.test/mcp",
          oauthCallbackUrl: "http://127.0.0.1:4118/callback",
        },
      }),
    ).toThrow(CodexMcpOAuthCallbackUrlConflictError);
  });

  it("does not reject port conflicts when reading only the callback URL", () => {
    expect(
      readCodexMcpOAuthCallbackUrl({
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauthCallbackPort: 3118,
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
        observability: {
          type: "http",
          url: "https://observability.example.test/mcp",
          oauthCallbackPort: 4118,
          oauthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
      }),
    ).toBe("http://127.0.0.1:3118/callback");
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

describe("Claude MCP tool filters", () => {
  const filters = buildMcpToolFilters({
    team__docs: {
      type: "stdio",
      command: "node",
      enabledTools: ["a__b", "blocked"],
      disabledTools: ["blocked"],
    },
    "team docs.v2": { type: "http", url: "https://example.test", disabledTools: ["write"] },
    unrestricted: { type: "stdio", command: "node", enabledTools: [] },
    disabled: { type: "stdio", command: "node", enabled: false, disabledTools: ["read"] },
  });
  const owned = new Set(filters.keys());

  it("normalizes only characters Claude replaces, retaining double underscores", () => {
    expect(normalizeClaudeMcpName("team docs.v2__docs-/a")).toBe("team_docs_v2__docs-_a");
  });

  it("builds denied tool names for enabled servers only", () => {
    expect(filters.has("disabled")).toBe(false);
    expect(claudeDisallowedMcpToolNames(filters)).toEqual([
      "mcp__team__docs__blocked",
      "mcp__team_docs_v2__write",
    ]);
  });

  it.each([
    ["team__docs", "a__b", false],
    ["team__docs", "blocked", true],
    ["team__docs", "missing", true],
    ["team docs.v2", "read", false],
    ["team docs.v2", "write", true],
    ["unrestricted", "anything", false],
  ] as const)("enforces %s / %s with and without provenance", (name, tool, denied) => {
    const toolName = `mcp__${normalizeClaudeMcpName(name)}__${tool}`;
    for (const provenance of [undefined, { name, source: "dynamic" }, { name }]) {
      const reason = evaluateMcpToolFilter(filters, owned, toolName, provenance);
      expect(Boolean(reason)).toBe(denied);
      if (denied) {
        expect(reason).toContain(tool);
        expect(reason).toContain(name);
        expect(reason).toContain("F5 MCP settings");
      }
    }
  });

  it("ignores SDK, external and unowned servers", () => {
    for (const source of ["sdk", "project", "user", "plugin"]) {
      expect(
        evaluateMcpToolFilter(filters, owned, "mcp__team__docs__blocked", {
          name: "team__docs",
          source,
        }),
      ).toBeUndefined();
    }
    expect(
      evaluateMcpToolFilter(filters, new Set(), "mcp__team__docs__blocked", { name: "team__docs" }),
    ).toBeUndefined();
    expect(evaluateMcpToolFilter(filters, owned, "Read")).toBeUndefined();
  });

  it("denies every tool from an owned server whose filter was removed", () => {
    for (const provenance of [
      undefined,
      { name: "team__docs", source: "dynamic" },
      { name: "team__docs" },
    ]) {
      for (const tool of ["a__b", "write"]) {
        const reason = evaluateMcpToolFilter(
          new Map(),
          owned,
          `mcp__team__docs__${tool}`,
          provenance,
        );
        expect(reason).toContain(tool);
        expect(reason).toContain("team__docs");
        expect(reason).toContain("removed or disabled in F5 MCP settings");
      }
    }
    expect(
      evaluateMcpToolFilter(new Map(), owned, "mcp__team__docs__write", {
        name: "team__docs",
        source: "sdk",
      }),
    ).toBeUndefined();
  });

  it("fails closed on a mismatched prefix", () => {
    expect(
      evaluateMcpToolFilter(filters, owned, "mcp__other__a__b", {
        name: "team__docs",
        source: "dynamic",
      }),
    ).toContain("F5 MCP settings");
  });

  it("checks every normalized alias when provenance is absent", () => {
    const aliases = buildMcpToolFilters({
      "a.b": { type: "stdio", command: "node", disabledTools: ["write"] },
      a_b: { type: "stdio", command: "node" },
    });
    expect(evaluateMcpToolFilter(aliases, new Set(aliases.keys()), "mcp__a_b__write")).toContain(
      "a.b",
    );
  });
});
