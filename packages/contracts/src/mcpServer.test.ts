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
    });

    expect(parsed.type).toBe("stdio");
    expect(parsed.command).toBe("npx");
    expect(parsed.enabledTools).toEqual(["read_file"]);
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
});
