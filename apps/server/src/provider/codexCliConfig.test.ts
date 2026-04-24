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
      buildCodexCliMcpConfigArgs({
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["@modelcontextprotocol/server-filesystem", "/repo"],
        },
      }),
    ).toEqual([
      "-c",
      'mcp_servers={"filesystem"={"type"="stdio","command"="npx","args"=["@modelcontextprotocol/server-filesystem","/repo"]}}',
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
});
