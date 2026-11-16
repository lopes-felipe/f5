import { describe, expect, it } from "vitest";
import {
  boundMcpObservation,
  projectMcpStatuses,
  CLAUDE_MCP_AUTH_MESSAGE,
} from "./mcpInspection.ts";
import { classifyMcpOwnership, type McpAdapterObservation } from "../provider/mcpObservation.ts";
import { observeCodexMcpServers } from "../provider/codexMcpObservation.ts";

const capabilities = { tools: true, inputSchemas: true, resources: true };
const observation = (
  servers: McpAdapterObservation["servers"],
  complete = true,
): McpAdapterObservation => ({ servers, complete, capabilities });
const config = { docs: { type: "stdio" as const, command: "node" } };

describe("MCP observations", () => {
  it("keeps a removed managed server visible until the live connection is removed", () => {
    const statuses = projectMcpStatuses(
      {},
      observation([{ name: "docs", status: "connected", ownership: "managed" }]),
      "claudeAgent",
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: "docs",
      state: "ready",
      desiredEnabled: false,
      ownership: "managed",
    });
    expect(statuses[0]?.message).toContain("removal pending");
  });
  it("uses the shared credential classifier for schemas and annotations", () => {
    const credentials = {
      token: "bare",
      api_key: "underscored",
      apiKey: "camel",
      accessToken: "access",
      password: "pw",
      cookie: "cookie-value",
    };
    const result = boundMcpObservation(
      observation([
        {
          name: "docs",
          status: "connected",
          tools: [{ name: "ping", inputSchema: credentials, annotations: credentials }],
        },
      ]),
      {},
    );
    const redacted = Object.fromEntries(Object.keys(credentials).map((key) => [key, "[redacted]"]));
    expect(result.servers[0]?.tools?.[0]).toMatchObject({
      inputSchema: redacted,
      annotations: redacted,
    });
  });
  it("keeps saved disabled state separate from a live connection", () => {
    const statuses = projectMcpStatuses(
      { docs: { ...config.docs, enabled: false } },
      observation([{ name: "docs", status: "connected", ownership: "managed" }]),
      "claudeAgent",
    );
    expect(statuses[0]).toMatchObject({ state: "ready", desiredEnabled: false });
    expect(statuses[0]?.message).toContain("still connected in this conversation; apply pending");
  });
  it("never assigns an external same-name server to a managed row", () => {
    const statuses = projectMcpStatuses(
      config,
      observation([{ name: "docs", status: "connected", ownership: "external", origin: "plugin" }]),
      "claudeAgent",
    );
    expect(statuses.map((entry) => [entry.ownership, entry.state])).toEqual([
      ["managed", "unknown"],
      ["external", "ready"],
    ]);
  });
  it("uses registered provenance for built-ins, with no name-prefix trust", () => {
    expect(
      classifyMcpOwnership({ name: "preview", source: "sdk" }, new Set(), new Set(["preview"])),
    ).toBe("built-in");
    expect(
      classifyMcpOwnership({ name: "preview", source: "plugin" }, new Set(), new Set(["preview"])),
    ).toBe("external");
    expect(classifyMcpOwnership({ name: "f5-computer-spoof", source: "sdk" }, new Set())).toBe(
      "external",
    );
    expect(classifyMcpOwnership({ name: "docs", source: "user" }, new Set(["docs"]))).toBe(
      "external",
    );
  });
  it("marks absence unknown when pagination is incomplete", () => {
    const [status] = projectMcpStatuses(config, observation([], false), "codex");
    expect(status?.state).toBe("unknown");
    expect(status?.message).toContain("incomplete");
  });
  it("shows Claude's interactive authentication instructions", () => {
    const [status] = projectMcpStatuses(
      config,
      observation([{ name: "docs", status: "needs-auth", ownership: "managed" }]),
      "claudeAgent",
    );
    expect(status?.message).toBe(CLAUDE_MCP_AUTH_MESSAGE);
  });
  it.each([
    [{ name: "docs", tools: { ping: {} } }, "connected"],
    [{ name: "docs", resources: [{ name: "one" }] }, "connected"],
    [{ name: "docs", startupStatus: "ready" as const }, "connected"],
    [{ name: "docs", authStatus: "oAuth" }, "unknown"],
    [{ name: "docs", authStatus: "notLoggedIn" }, "needs-auth"],
  ])("maps Codex evidence without inventing a zero-tool failure", (server, expected) => {
    expect(observeCodexMcpServers([server], new Set(["docs"]))[0]?.status).toBe(expected);
  });
  it("caps schemas, nesting, items, and the complete output", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 34; depth++) {
      const child = {};
      cursor.child = child;
      cursor = child;
    }
    const tools = Array.from({ length: 1500 }, (_, index) => ({
      name: String(index),
      description: "x".repeat(5000),
      inputSchema:
        index === 0 ? deep : { properties: Array.from({ length: 100 }, () => "y".repeat(1000)) },
    }));
    const result = boundMcpObservation(
      observation([{ name: "docs", status: "connected", ownership: "managed", tools }]),
      config,
    );
    expect(result.complete).toBe(false);
    expect(result.omissions?.length).toBeGreaterThan(0);
    expect(result.servers[0]?.tools?.length).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
    for (const tool of result.servers[0]?.tools ?? [])
      expect(Buffer.byteLength(JSON.stringify(tool.inputSchema))).toBeLessThanOrEqual(65536);
  });
  it("projects only metadata and scrubs secrets from errors and schemas", () => {
    const result = boundMcpObservation(
      observation([
        {
          name: "docs",
          status: "failed",
          error: "secret-value-123 https://user:pass@example.test/mcp?token=bad#fragment",
          tools: [
            {
              name: "ping",
              inputSchema: {
                Authorization: "Bearer abcdefgh",
                properties: { value: { type: "string" } },
              },
            },
          ],
          resources: [
            {
              name: "one",
              uri: "https://user:pass@example.test/?secret=abc",
              config: { password: "never serialize" },
            },
          ],
        },
      ]),
      { docs: { ...config.docs, env: { TOKEN: "secret-value-123" } } },
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain("secret-value-123");
    expect(json).not.toContain("user:pass");
    expect(json).not.toContain("?token");
    expect(json).not.toContain("never serialize");
    expect(json).not.toContain("Bearer abcdefgh");
  });
});
