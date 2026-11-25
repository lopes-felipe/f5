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
import type { McpHubAttachmentUpdate } from "../../mcp/hub/McpHub.ts";

const noUpdate = (): McpHubAttachmentUpdate => ({
  changed: [],
  removed: [],
  added: [],
  addedEndpoints: [],
  endpoints: [],
  omitted: [],
});

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
        "secret-token-value",
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

  it("registers a short bearer token, since it is an explicit credential", () => {
    const resolved = resolveCursorMcpServers({
      automationServers: [],
      projectServers: {
        token: { type: "http", url: "https://token.example", bearerTokenEnvVar: "TOKEN_VAR" },
      } as unknown as McpProjectServersConfig,
      cursorConfigNames: new Set(),
      capabilities: { http: true, sse: true },
      environment: { TOKEN_VAR: "secret" },
    });
    expect(cursorMcpServerSecrets(resolved.servers, resolved.ownedNames)).toEqual(
      expect.arrayContaining(["Bearer secret", "secret"]),
    );
  });

  it("reads Cursor's mcp.json only from bounded files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-mcp-names-"));
    try {
      await mkdir(path.join(root, "config"));
      await mkdir(path.join(root, "workspace", ".cursor"), { recursive: true });
      await writeFile(
        path.join(root, "config", "mcp.json"),
        JSON.stringify({ mcpServers: { user: {} } }),
      );
      await writeFile(
        path.join(root, "workspace", ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { project: {} } }),
      );
      expect(
        [
          ...(await readCursorMcpConfigNames({
            configDir: path.join(root, "config"),
            cwd: path.join(root, "workspace"),
          })),
        ].toSorted(),
      ).toEqual(["project", "user"]);
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

  // FIFOs are POSIX-only.
  it.skipIf(process.platform === "win32")(
    "skips an mcp.json that is not a regular file",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cursor-mcp-fifo-"));
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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("routes every eligible server, stdio included, through the hub", () => {
    const attached: string[][] = [];
    let disposed = false;
    const resolved = resolveCursorMcpServers({
      automationServers: [
        { type: "http", name: "f5_thread_abc", url: "http://127.0.0.1/x", headers: [] },
      ],
      projectServers: project,
      cursorConfigNames: new Set(["shared"]),
      capabilities: { http: true, sse: false },
      attachHub: (servers) => {
        attached.push(Object.keys(servers));
        return {
          endpoints: Object.keys(servers)
            .filter((name) => name !== "events")
            .map((name) => ({
              serverName: name,
              url: `http://127.0.0.1:9/mcp/user/${name}`,
              token: `token-${name}`,
              transport: servers[name]!.type,
              toolTimeoutMs: 600_000,
            })),
          omitted: [{ serverName: "events", reason: "could not start" }],
          credentials: [],
          update: noUpdate,
          dispose: async () => {
            disposed = true;
          },
        };
      },
    });
    expect(attached).toEqual([["docs", "events", "local", "token"]]);
    expect(resolved.servers.map((server) => server.name)).toEqual([
      "f5_thread_abc",
      "docs",
      "local",
      "token",
    ]);
    expect(resolved.servers[2]).toEqual({
      type: "http",
      name: "local",
      url: "http://127.0.0.1:9/mcp/user/local",
      headers: [{ name: "Authorization", value: "Bearer token-local" }],
    });
    expect(resolved.ownedNames).toEqual(["docs", "local", "token"]);
    expect(resolved.omitted.map((entry) => entry.name).toSorted()).toEqual([
      "events",
      "f5_preview",
      "shared",
    ]);
    void resolved.dispose?.();
    expect(disposed).toBe(true);
  });

  it("uses the stdio shim when Cursor offers no HTTP MCP", () => {
    const resolved = resolveCursorMcpServers({
      automationServers: [],
      projectServers: { local: { type: "stdio", command: "node" } } as McpProjectServersConfig,
      cursorConfigNames: new Set(),
      capabilities: { http: false, sse: false },
      stdioLaunch: { command: "/bin/t3", args: ["mcp-session-stdio"], env: {} },
      attachHub: () => ({
        endpoints: [
          {
            serverName: "local",
            url: "http://127.0.0.1:9/mcp/user/a",
            token: "secret-token",
            transport: "stdio",
            toolTimeoutMs: 600_000,
          },
        ],
        omitted: [],
        credentials: [],
        update: noUpdate,
        dispose: async () => undefined,
      }),
    });
    expect(resolved.servers).toEqual([
      expect.objectContaining({
        name: "local",
        command: "/bin/t3",
        args: ["mcp-session-stdio"],
        env: expect.arrayContaining([
          { name: "F5_MCP_URL", value: "http://127.0.0.1:9/mcp/user/a" },
          { name: "F5_MCP_TOKEN", value: "secret-token" },
        ]),
      }),
    ]);
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
