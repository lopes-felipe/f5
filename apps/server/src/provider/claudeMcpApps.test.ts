import { describe, expect, it } from "vitest";

import {
  CLAUDE_MCP_APP_CATALOG_MAX_AGE_MS,
  CLAUDE_MCP_APP_UNAVAILABLE,
  buildClaudeMcpAppCatalog,
  callClaudeMcpAppTool,
  isClaudeMcpAppCatalogFresh,
  readClaudeMcpAppToolResult,
  resolveClaudeMcpAppTool,
} from "./claudeMcpApps.ts";

const statuses = [
  {
    name: "charts",
    status: "connected",
    config: { type: "stdio", command: "charts" },
    tools: [
      {
        name: "show_chart",
        description: "Renders a chart",
        annotations: { readOnly: true, openWorld: false },
        _meta: { ui: { resourceUri: "ui://charts/view", visibility: ["model", "app", "other"] } },
      },
      { name: "legacy", _meta: { "ui/resourceUri": "ui://charts/legacy" } },
      { name: "remote", _meta: { ui: { resourceUri: "https://example.invalid/app" } } },
      { name: "long", _meta: { ui: { resourceUri: `ui://${"x".repeat(4096)}` } } },
      { name: "plain", annotations: { destructive: true } },
    ],
  },
  {
    name: "f5_thread",
    config: { type: "sdk" },
    tools: [{ name: "thread_read", _meta: { ui: { resourceUri: "ui://f5/thread" } } }],
  },
  { name: "pending", status: "pending" },
];

describe("Claude MCP App catalog", () => {
  const catalog = buildClaudeMcpAppCatalog(statuses, 3, 1_000);

  it("maps Claude annotations and ui metadata into F5's MCP App tool shape", () => {
    expect(catalog.servers.get("charts")?.get("show_chart")).toEqual({
      name: "show_chart",
      description: "Renders a chart",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://charts/view", visibility: ["model", "app", "other"] } },
      resourceUri: "ui://charts/view",
      visibility: ["model", "app"],
    });
    expect(catalog.servers.get("charts")?.get("plain")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
      visibility: [],
    });
    expect(catalog.servers.has("pending")).toBe(false);
    expect(catalog.sdkServers).toEqual(new Set(["f5_thread"]));
  });

  it("resolves only bounded ui:// resources on non-SDK servers", () => {
    expect(resolveClaudeMcpAppTool(catalog, "mcp__charts__show_chart")).toEqual({
      server: "charts",
      tool: "show_chart",
      resourceUri: "ui://charts/view",
    });
    expect(resolveClaudeMcpAppTool(catalog, "mcp__charts__legacy")?.resourceUri).toBe(
      "ui://charts/legacy",
    );
    for (const name of [
      "mcp__charts__remote",
      "mcp__charts__long",
      "mcp__charts__plain",
      "mcp__charts__missing",
      "mcp__f5_thread__thread_read",
      "Read",
    ])
      expect(resolveClaudeMcpAppTool(catalog, name), name).toBeUndefined();
    expect(resolveClaudeMcpAppTool(undefined, "mcp__charts__show_chart")).toBeUndefined();
  });

  it("is stale after the max age or a new session epoch", () => {
    expect(
      isClaudeMcpAppCatalogFresh(catalog, 3, 1_000 + CLAUDE_MCP_APP_CATALOG_MAX_AGE_MS - 1),
    ).toBe(true);
    expect(isClaudeMcpAppCatalogFresh(catalog, 3, 1_000 + CLAUDE_MCP_APP_CATALOG_MAX_AGE_MS)).toBe(
      false,
    );
    expect(isClaudeMcpAppCatalogFresh(catalog, 4, 1_000)).toBe(false);
    expect(isClaudeMcpAppCatalogFresh(undefined, 3, 1_000)).toBe(false);
  });
});

describe("Claude MCP App tool results and calls", () => {
  it("prefers a structured CallToolResult and falls back to the tool_result content", () => {
    const structured = { content: [{ type: "text", text: "structured" }] };
    expect(readClaudeMcpAppToolResult(structured, "ignored")).toMatchObject(structured);
    expect(readClaudeMcpAppToolResult(undefined, "plain")).toMatchObject({
      content: [{ type: "text", text: "plain" }],
    });
    expect(readClaudeMcpAppToolResult(undefined, [{ type: "text", text: "block" }])).toMatchObject({
      content: [{ type: "text", text: "block" }],
    });
  });

  it("refuses without the CLI capability or the SDK request internal", async () => {
    const request = async () => ({ response: {} });
    await expect(
      callClaudeMcpAppTool({
        query: { request },
        capabilities: new Set(),
        server: "charts",
        tool: "show_chart",
        arguments: {},
      }),
    ).rejects.toThrow(CLAUDE_MCP_APP_UNAVAILABLE);
    await expect(
      callClaudeMcpAppTool({
        query: {},
        capabilities: new Set(["mcp_call_result_not_for_model_v1"]),
        server: "charts",
        tool: "show_chart",
        arguments: {},
      }),
    ).rejects.toThrow(CLAUDE_MCP_APP_UNAVAILABLE);
  });

  it("sends a fully-qualified tool with result_not_for_model and passes the signal", async () => {
    const calls: unknown[] = [];
    const signal = new AbortController().signal;
    const result = await callClaudeMcpAppTool({
      query: {
        request: async (request: unknown, options: unknown) => {
          calls.push(request, options);
          return { response: { content: [] } };
        },
      },
      capabilities: new Set(["mcp_call_result_not_for_model_v1"]),
      server: "charts",
      tool: "show_chart",
      arguments: { range: "week" },
      signal,
    });
    expect(result).toEqual({ content: [] });
    expect(calls).toEqual([
      {
        subtype: "mcp_call",
        tool: "mcp__charts__show_chart",
        arguments: { range: "week" },
        result_not_for_model: true,
      },
      { signal },
    ]);
  });
});
