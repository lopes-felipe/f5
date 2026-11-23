import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { McpProjectServersConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  cursorMcpServerSecrets,
  describeCursorMcpOmissions,
  readCursorMcpConfigNames,
  resolveCursorMcpServers,
} from "./cursorMcpServers.ts";

const project = {
  docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-Team": "a" } },
  events: { type: "sse", url: "https://events.example/sse" },
  local: { type: "stdio", command: "node", args: ["server.js"] },
  f5_preview: { type: "http", url: "https://impostor.example" },
  shared: { type: "http", url: "https://shared.example" },
  token: { type: "http", url: "https://token.example", bearerTokenEnvVar: "TOKEN_VAR" },
  off: { type: "http", url: "https://off.example", enabled: false },
} as unknown as McpProjectServersConfig;

describe("resolveCursorMcpServers", () => {
  it("keeps F5 servers first and reports every omitted project server", () => {
    const resolved = resolveCursorMcpServers({
      automationServers: [
        { type: "http", name: "f5_thread_abc", url: "http://127.0.0.1/x", headers: [] },
      ],
      projectServers: project,
      cursorConfigNames: new Set(["shared"]),
      capabilities: { http: true, sse: false },
      environment: { TOKEN_VAR: "secret" },
    });
    expect(resolved.servers.map((server) => server.name)).toEqual([
      "f5_thread_abc",
      "docs",
      "token",
    ]);
    expect(resolved.ownedNames).toEqual(["docs", "token"]);
    expect(resolved.servers[1]).toEqual({
      type: "http",
      name: "docs",
      url: "https://docs.example/mcp",
      headers: [{ name: "X-Team", value: "a" }],
    });
    expect(resolved.servers[2]).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
    expect(resolved.omitted.map((entry) => entry.name).toSorted()).toEqual([
      "events",
      "f5_preview",
      "local",
      "shared",
    ]);
    expect(describeCursorMcpOmissions(resolved.omitted)?.summary).toBe(
      "F5 did not pass 4 MCP servers to Cursor.",
    );
  });

  it("lists every forwarded credential for the diagnostics scrubber", () => {
    const resolved = resolveCursorMcpServers({
      automationServers: [
        { type: "http", name: "f5_thread", url: "http://127.0.0.1/x", headers: [] },
      ],
      projectServers: {
        keyed: {
          type: "http",
          url: "https://user:pass1234@keyed.example/mcp?api_key=k1&session=long-session-value#frag",
          headers: { "X-Custom": "custom-header-value" },
        },
        token: { type: "http", url: "https://token.example", bearerTokenEnvVar: "TOKEN_VAR" },
      } as unknown as McpProjectServersConfig,
      cursorConfigNames: new Set(),
      capabilities: { http: true, sse: true },
      environment: { TOKEN_VAR: "secret-token-value" },
    });
    const secrets = cursorMcpServerSecrets(resolved.servers, resolved.ownedNames);
    expect(secrets).toEqual(
      expect.arrayContaining([
        "custom-header-value",
        "Bearer secret-token-value",
        "?api_key=k1&session=long-session-value",
        "long-session-value",
        "pass1234",
        "#frag",
      ]),
    );
    // A short query value is still covered by the registered query string.
    expect(secrets.some((secret) => secret.includes("api_key=k1"))).toBe(true);
    // F5's own servers are scrubbed by their catalog, not listed here.
    expect(secrets.some((secret) => secret.includes("127.0.0.1"))).toBe(false);
  });

  it("reads Cursor's mcp.json only from bounded regular files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-mcp-names-"));
    try {
      await mkdir(path.join(root, "config"));
      await mkdir(path.join(root, "workspace", ".cursor"), { recursive: true });
      await writeFile(
        path.join(root, "config", "mcp.json"),
        JSON.stringify({ mcpServers: { user: {} } }),
      );
      execFileSync("mkfifo", [path.join(root, "workspace", ".cursor", "mcp.json")]);
      expect([
        ...(await readCursorMcpConfigNames({
          configDir: path.join(root, "config"),
          cwd: path.join(root, "workspace"),
        })),
      ]).toEqual(["user"]);
      await writeFile(
        path.join(root, "config", "mcp.json"),
        JSON.stringify({ mcpServers: { huge: {} }, padding: "x".repeat(1_100_000) }),
      );
      expect(
        (
          await readCursorMcpConfigNames({
            configDir: path.join(root, "config"),
            cwd: path.join(root, "missing"),
          })
        ).size,
      ).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports nothing when every server is forwarded", () => {
    const resolved = resolveCursorMcpServers({
      automationServers: [],
      projectServers: undefined,
      cursorConfigNames: new Set(),
      capabilities: { http: true, sse: true },
    });
    expect(resolved.servers).toEqual([]);
    expect(describeCursorMcpOmissions(resolved.omitted)).toBeUndefined();
  });
});
