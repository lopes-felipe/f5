import { describe, expect, it } from "vitest";
import { parseImportedServers } from "./mcpImport";

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

// Characterize the existing parser while moving it; lossless import is a later phase.
describe("existing import behavior", () => {
  it.each(["mcpServers", "mcp_servers", null])("reads the JSON server map at %s", (rootKey) => {
    const servers = { docs: { url: "https://example.test/mcp", headers: { Token: "value" } } };
    expect(
      parseImportedServers(JSON.stringify(rootKey ? { [rootKey]: servers } : servers)),
    ).toEqual({
      docs: { type: "http", url: "https://example.test/mcp", headers: { Token: "value" } },
    });
  });

  it("skips SDK and invalid entries, and keeps valid stdio and SSE entries", () => {
    expect(
      parseImportedServers(
        JSON.stringify({
          mcpServers: {
            sdk: { type: "sdk", name: "sdk-server" },
            invalid: { type: "stdio" },
            shell: {
              command: " node ",
              args: [" first ", "", "second"],
              enabled: false,
              env: { TOKEN: "value", PORT: 3000, DEBUG: false },
            },
            events: { transport: "sse", url: "https://example.test/events" },
          },
        }),
      ),
    ).toEqual({
      shell: {
        type: "stdio",
        command: "node",
        args: [" first ", "", "second"],
        enabled: false,
        env: { TOKEN: "value" },
      },
      events: { type: "sse", url: "https://example.test/events" },
    });
  });

  it("preserves optional false, zero, and empty lists", () => {
    expect(
      parseImportedServers(
        JSON.stringify({
          docs: {
            command: "node",
            supportsParallelToolCalls: false,
            startupTimeoutSec: 0,
            toolTimeoutSec: 0,
            enabledTools: [],
          },
        }),
      ),
    ).toEqual({
      docs: {
        type: "stdio",
        command: "node",
        supportsParallelToolCalls: false,
        startupTimeoutSec: 0,
        toolTimeoutSec: 0,
        enabledTools: [],
      },
    });
  });

  it("reads basic TOML arrays, quoted names, comments, and nested tables", () => {
    expect(
      parseImportedServers(`
[mcp_servers."team.docs"]
command = "node" # comment
args = ["first,second", 'third']
[mcp_servers."team.docs".env]
PORT = "3000"
[mcp_servers.remote]
url = "https://example.test/mcp#fragment"
[mcp_servers.remote.headers]
Authorization = "Bearer example"
`),
    ).toEqual({
      "team.docs": {
        type: "stdio",
        command: "node",
        args: ["first,second", "third"],
        env: { PORT: "3000" },
      },
      remote: {
        type: "http",
        url: "https://example.test/mcp#fragment",
        headers: { Authorization: "Bearer example" },
      },
    });
  });

  it("preserves every imported server after sixteen", () => {
    const servers = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [` server-${index} `, { command: "node" }]),
    );
    const imported = parseImportedServers(JSON.stringify(servers));
    expect(Object.keys(imported)).toEqual(
      Array.from({ length: 17 }, (_, index) => `server-${index}`),
    );
  });

  it("returns no entries for empty input and still reports malformed JSON", () => {
    expect(parseImportedServers("  ")).toEqual({});
    expect(() => parseImportedServers('{"mcpServers":')).toThrow();
  });
});

describe("full TOML parsing", () => {
  it("preserves multiline arguments, inline tables, empty values, and http_headers", () => {
    expect(
      parseImportedServers(`
[mcp_servers.shell]
command = "node"
args = [
  "", "  spaces  ",
  """line one
line two""",
]
env = { TOKEN = " a=b " }
[mcp_servers.remote]
url = "http://localhost:3000/mcp"
http_headers = { Authorization = "Bearer token" }
`),
    ).toEqual({
      shell: {
        type: "stdio",
        command: "node",
        args: ["", "  spaces  ", "line one\nline two"],
        env: { TOKEN: " a=b " },
      },
      remote: {
        type: "http",
        url: "http://localhost:3000/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });
  });
});

it.each([
  JSON.stringify({ mcpServers: { shell: { command: "node", args: ["--port", 3000] } } }),
  '[mcp_servers.shell]\ncommand = "node"\nargs = ["--port", 3000]',
])("rejects malformed arguments atomically and names the server", (text) => {
  expect(() => parseImportedServers(text)).toThrow(
    "Cannot import MCP server 'shell': args must be an array of strings",
  );
});
it("preserves explicit empty identifier lists without turning whitespace into an empty list", () => {
  expect(
    parseImportedServers(
      JSON.stringify({
        shell: { command: "node", args: [], enabledTools: [" "], disabledTools: [], scopes: [] },
      }),
    ),
  ).toEqual({ shell: { type: "stdio", command: "node", args: [], disabledTools: [], scopes: [] } });
});
