import { describe, expect, it } from "vitest";

import {
  buildCodexCliMcpConfigArgs,
  prependCodexCliTelemetryDisabledConfig,
} from "./codexCliConfig";

describe("buildCodexCliMcpConfigArgs", () => {
  it("always emits an explicit empty mcp_servers override", () => {
    expect(buildCodexCliMcpConfigArgs(undefined)).toEqual(["-c", "mcp_servers={}"]);
  });

  it("serializes inline MCP server overrides", () => {
    expect(
      buildCodexCliMcpConfigArgs(
        {
          filesystem: {
            type: "stdio",
            command: "npx",
            args: ["@modelcontextprotocol/server-filesystem", "/repo"],
          },
        },
        {
          mcpOAuthCallbackPort: 3118,
          mcpOAuthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
      ),
    ).toEqual([
      "-c",
      'mcp_servers={"filesystem"={"type"="stdio","command"="npx","args"=["@modelcontextprotocol/server-filesystem","/repo"]}}',
      "-c",
      "mcp_oauth_callback_port=3118",
      "-c",
      'mcp_oauth_callback_url="http://127.0.0.1:3118/callback"',
    ]);
  });

  it("quotes keys with TOML-significant characters", () => {
    expect(
      buildCodexCliMcpConfigArgs({
        'danger = key, } "quoted"': {
          type: "http",
          url: "https://mcp.example.test",
          headers: {
            'X Danger.Key "quoted"': "Bearer secret",
          },
        },
      }),
    ).toEqual([
      "-c",
      'mcp_servers={"danger = key, } \\"quoted\\""={"type"="http","url"="https://mcp.example.test","headers"={"X Danger.Key \\"quoted\\""="Bearer secret"}}}',
    ]);
  });

  it("escapes callback URLs with TOML-significant characters", () => {
    expect(
      buildCodexCliMcpConfigArgs(
        {},
        {
          mcpOAuthCallbackUrl: "http://127.0.0.1:3118/callback?next=%2Fmcp%2Fdone&state=a=b",
        },
      ),
    ).toEqual([
      "-c",
      "mcp_servers={}",
      "-c",
      'mcp_oauth_callback_url="http://127.0.0.1:3118/callback?next=%2Fmcp%2Fdone&state=a=b"',
    ]);
  });
});

describe("prependCodexCliTelemetryDisabledConfig", () => {
  it("prepends config overrides that disable Codex analytics and OTEL exporters", () => {
    expect(prependCodexCliTelemetryDisabledConfig(["app-server"])).toEqual([
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      "mcp_servers={}",
      "app-server",
    ]);
  });

  it("disables native shell, patch, web, app, and delegation tools for read-only stages", () => {
    const args = prependCodexCliTelemetryDisabledConfig([], { readOnlyWorkflow: true });
    for (const setting of [
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.apps=false",
      "features.browser_use=false",
      "features.computer_use=false",
      "features.plugins=false",
      "features.multi_agent=false",
      "include_apply_patch_tool=false",
      'web_search="disabled"',
    ]) {
      expect(args).toContain(setting);
    }
    expect(prependCodexCliTelemetryDisabledConfig([])).not.toContain("features.shell_tool=false");
  });
});
