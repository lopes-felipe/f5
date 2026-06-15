import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { McpServerDefinition } from "./mcpServer";

const decodeMcpServerDefinition = Schema.decodeUnknownSync(McpServerDefinition);

describe("McpServerDefinition", () => {
  it("accepts stdio servers with advanced shared fields", () => {
    const parsed = decodeMcpServerDefinition({
      type: "stdio",
      command: "npx",
      args: ["@modelcontextprotocol/server-filesystem"],
      enabledTools: ["read_file"],
      startupTimeoutSec: 30,
      oauthClientId: "client-1",
      oauthCallbackPort: 3118,
      oauthCallbackUrl: "http://127.0.0.1:3118/callback",
    });

    expect(parsed.type).toBe("stdio");
    expect(parsed.command).toBe("npx");
    expect(parsed.enabledTools).toEqual(["read_file"]);
    expect(parsed.oauthClientId).toBe("client-1");
    expect(parsed.oauthCallbackPort).toBe(3118);
    expect(parsed.oauthCallbackUrl).toBe("http://127.0.0.1:3118/callback");
  });

  it("rejects stdio servers with remote-only fields", () => {
    expect(() =>
      decodeMcpServerDefinition({
        type: "stdio",
        command: "npx",
        url: "https://example.test/mcp",
      }),
    ).toThrow();
  });

  it("rejects remote servers with stdio-only fields", () => {
    expect(() =>
      decodeMcpServerDefinition({
        type: "http",
        url: "https://example.test/mcp",
        command: "node",
      }),
    ).toThrow();
  });

  it("rejects invalid OAuth callback ports", () => {
    expect(() =>
      decodeMcpServerDefinition({
        type: "http",
        url: "https://example.test/mcp",
        oauthCallbackPort: 0,
      }),
    ).toThrow();

    expect(() =>
      decodeMcpServerDefinition({
        type: "http",
        url: "https://example.test/mcp",
        oauthCallbackPort: 65536,
      }),
    ).toThrow();
  });

  it("rejects invalid OAuth callback URLs", () => {
    expect(() =>
      decodeMcpServerDefinition({
        type: "http",
        url: "https://example.test/mcp",
        oauthCallbackUrl: "not-a-url",
      }),
    ).toThrow();

    expect(() =>
      decodeMcpServerDefinition({
        type: "http",
        url: "https://example.test/mcp",
        oauthCallbackUrl: "ftp://127.0.0.1/callback",
      }),
    ).toThrow();

    expect(() =>
      decodeMcpServerDefinition({
        type: "http",
        url: "https://example.test/mcp",
        oauthCallbackUrl: "http://[unterminated",
      }),
    ).toThrow();
  });
});
