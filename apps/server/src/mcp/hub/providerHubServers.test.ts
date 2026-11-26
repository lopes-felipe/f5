import { describe, expect, it } from "vitest";

import type { McpHubEndpoint } from "./McpHub.ts";
import { codexMcpConsentToolName, hubAsksForClaudeTool } from "./providerHubServers.ts";

const endpoint = (serverName: string): McpHubEndpoint => ({
  serverName,
  url: `http://127.0.0.1:1/mcp/user/${serverName}`,
  token: "t",
  transport: "http",
  toolTimeoutMs: 1000,
  startupTimeoutMs: 30_000,
});

describe("one prompt per hub tool call", () => {
  it("allows Claude's own prompt only for hub tools F5 asks about", () => {
    const asks = new Set(["linear/create_issue"]);
    const attachment = {
      endpoints: [endpoint("linear"), endpoint("my.server")],
      asksBeforeCall: (server: string, tool: string) => asks.has(`${server}/${tool}`),
    };
    expect(hubAsksForClaudeTool(attachment, "mcp__linear__create_issue")).toBe(true);
    expect(hubAsksForClaudeTool(attachment, "mcp__linear__list_issues")).toBe(false);
    expect(hubAsksForClaudeTool(attachment, "Bash")).toBe(false);
    // The SDK's server provenance must match the hub server.
    expect(hubAsksForClaudeTool(attachment, "mcp__linear__create_issue", { name: "other" })).toBe(
      false,
    );
    expect(hubAsksForClaudeTool(undefined, "mcp__linear__create_issue")).toBe(false);
  });

  it("reads the tool from Codex's MCP tool-call consent prompt", () => {
    expect(
      codexMcpConsentToolName({
        serverName: "linear",
        _meta: { codex_approval_kind: "mcp_tool_call" },
        message: 'Allow the linear MCP server to run tool "create_issue"?',
      }),
    ).toBe("create_issue");
    expect(
      codexMcpConsentToolName({
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "search" },
        message: "anything",
      }),
    ).toBe("search");
    // Other elicitations are the server's own questions, never answered for the user.
    expect(
      codexMcpConsentToolName({ message: 'Allow the linear MCP server to run tool "x"?' }),
    ).toBeUndefined();
  });
});
