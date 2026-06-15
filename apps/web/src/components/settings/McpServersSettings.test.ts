import { describe, expect, it } from "vitest";

import { parseImportedServers } from "./McpServersSettings";

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
