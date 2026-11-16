import { describe, expect, it } from "vitest";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";
import headerFixture from "./fixtures/codex-0.162.1-mcp-headers.json";

import {
  buildCodexCliMcpConfigArgs,
  prependCodexCliTelemetryDisabledConfig,
} from "./codexCliConfig";

describe("buildCodexCliMcpConfigArgs", () => {
  it("matches the installed Codex 0.162.1 header-key fixture", () => {
    expect(headerFixture.version).toBe("codex-cli 0.162.1");
    const accepted = headerFixture.cases.find((entry) => entry.field === "http_headers")!;
    const translated = translateMcpForCodex({
      fixture: {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { "X-Fixture": "fixture-value" },
      },
    });
    expect(buildCodexCliMcpConfigArgs(translated)).toEqual(accepted.args.slice(0, 2));
    expect(translated!.fixture!.http_headers).toEqual(accepted.servers[0]!.transport.http_headers);
    const envHeaders = headerFixture.cases.find((entry) => entry.field === "env_http_headers")!;
    expect(envHeaders.servers[0]!.transport.env_http_headers).toEqual({
      "X-Fixture": "fixture-value",
    });
    const ignored = headerFixture.cases.find((entry) => entry.field === "headers")!;
    expect(ignored.servers[0]!.transport.http_headers).toBeNull();
    expect(ignored.servers[0]!.transport.env_http_headers).toBeNull();
  });

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
      'mcp_servers={"filesystem"={"command"="npx","args"=["@modelcontextprotocol/server-filesystem","/repo"]}}',
      "-c",
      "mcp_oauth_callback_port=3118",
      "-c",
      'mcp_oauth_callback_url="http://127.0.0.1:3118/callback"',
    ]);
  });

  it("omits the internal transport discriminant Codex does not recognize", () => {
    const [, serialized] = buildCodexCliMcpConfigArgs({
      local: { type: "stdio", command: "node" },
      remote: { type: "http", url: "http://127.0.0.1:3000/mcp" },
    });
    expect(serialized).toBe(
      'mcp_servers={"local"={"command"="node"},"remote"={"url"="http://127.0.0.1:3000/mcp"}}',
    );
    expect(serialized).not.toContain('"type"');
  });

  it("quotes keys with TOML-significant characters", () => {
    expect(
      buildCodexCliMcpConfigArgs({
        'danger = key, } "quoted"': {
          type: "http",
          url: "https://mcp.example.test",
          http_headers: {
            'X Danger.Key "quoted"': "Bearer secret",
          },
        },
      }),
    ).toEqual([
      "-c",
      'mcp_servers={"danger = key, } \\"quoted\\""={"url"="https://mcp.example.test","http_headers"={"X Danger.Key \\"quoted\\""="Bearer secret"}}}',
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
});
