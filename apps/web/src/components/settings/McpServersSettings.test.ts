import { describe, expect, it } from "vitest";

import { describeMcpApplyProblems, parseImportedServers } from "./McpServersSettings";

describe("describeMcpApplyProblems", () => {
  it("is silent when every session converged", () => {
    expect(
      describeMcpApplyProblems({
        scope: "project",
        codexReloaded: 1,
        claudeRestarted: 0,
        claudeReconciled: 1,
        skipped: 0,
      }),
    ).toBeNull();
  });

  it("reports deferred restarts and per-server errors", () => {
    expect(
      describeMcpApplyProblems({
        scope: "project",
        codexReloaded: 0,
        claudeRestarted: 0,
        deferred: 1,
        skipped: 0,
        failures: [
          { threadId: "t1", provider: "claudeAgent", restartRequired: true, errors: [] },
          {
            threadId: "t2",
            provider: "codex",
            restartRequired: false,
            errors: [{ server: "docs", message: "spawn ENOENT" }],
          },
        ],
      }),
    ).toBe(
      "1 session(s) will restart with the new MCP config at their next turn. 1 session(s) did not fully apply the MCP config (docs: spawn ENOENT).",
    );
  });
});

describe("parseImportedServers", () => {
  it("applies the top-level Codex OAuth callback port to HTTP TOML servers", () => {
    const servers = parseImportedServers(`
mcp_oauth_callback_port = 3118

[mcp_servers.slack]
type = "http"
url = "https://mcp.slack.com/mcp"
`);

    expect(servers.slack).toMatchObject({
      type: "http",
      url: "https://mcp.slack.com/mcp",
      oauthCallbackPort: 3118,
    });
  });

  it("applies the top-level Codex OAuth callback URL to HTTP TOML servers", () => {
    const servers = parseImportedServers(`
mcp_oauth_callback_url = "http://127.0.0.1:3118/callback"

[mcp_servers.slack]
type = "http"
url = "https://mcp.slack.com/mcp"
`);

    expect(servers.slack).toMatchObject({
      type: "http",
      url: "https://mcp.slack.com/mcp",
      oauthCallbackUrl: "http://127.0.0.1:3118/callback",
    });
  });

  it("applies the top-level Codex OAuth callback port to oauth_resource TOML servers", () => {
    const servers = parseImportedServers(`
mcp_oauth_callback_port = 3118

[mcp_servers.slack]
url = "https://mcp.slack.com/mcp"
oauth_resource = "https://slack.com"
`);

    expect(servers.slack).toMatchObject({
      type: "http",
      url: "https://mcp.slack.com/mcp",
      oauthCallbackPort: 3118,
      oauthResource: "https://slack.com",
    });
  });

  it("keeps an explicit server OAuth callback port over the top-level value", () => {
    const servers = parseImportedServers(`
mcp_oauth_callback_port = 3118

[mcp_servers.slack]
type = "http"
url = "https://mcp.slack.com/mcp"
oauth_callback_port = 4118
`);

    expect(servers.slack?.oauthCallbackPort).toBe(4118);
  });

  it("keeps a nested explicit server OAuth callback port over the top-level value", () => {
    const servers = parseImportedServers(`
mcp_oauth_callback_port = 3118

[mcp_servers.slack]
type = "http"
url = "https://mcp.slack.com/mcp"

[mcp_servers.slack.oauth]
callback_port = 4118
`);

    expect(servers.slack?.oauthCallbackPort).toBe(4118);
  });

  it("keeps a nested explicit server OAuth callback URL over the top-level value", () => {
    const servers = parseImportedServers(`
mcp_oauth_callback_url = "http://127.0.0.1:3118/callback"

[mcp_servers.slack]
type = "http"
url = "https://mcp.slack.com/mcp"

[mcp_servers.slack.oauth]
callback_url = "http://127.0.0.1:4118/callback"
`);

    expect(servers.slack?.oauthCallbackUrl).toBe("http://127.0.0.1:4118/callback");
  });
});
