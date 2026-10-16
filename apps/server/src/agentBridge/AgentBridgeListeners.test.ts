import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  AGENT_BRIDGE_SCOPES,
  type AgentBridgeScope,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import fixture20250618 from "./fixtures/mcp-2025-06-18.json" with { type: "json" };
import fixture20260728 from "./fixtures/mcp-2026-07-28.json" with { type: "json" };
import { startLocalListener, type LocalListener } from "./AgentBridgeListeners.ts";
import type { AgentBridgeClientRecord, AgentBridgeStore } from "./AgentBridgeStore.ts";
import { readAgentBridgeLocalCredentials } from "./localCredentials.ts";
import { assertMcpVersion, handleMcpRequest, UnsupportedMcpVersionError } from "./mcpProtocol.ts";
import { isAncestorProcess, parentProcessId } from "./processAncestry.ts";
import { makeAgentBridgeLimiters } from "./rateLimits.ts";
import { AGENT_BRIDGE_UNAVAILABLE_CODE, runAgentBridgeStdio } from "./stdioShim.ts";
import { FakeAgentBridgeHost, project } from "./testing/fakeHost.ts";
import {
  makeThreadTools,
  type AgentBridgeCaller,
  type AgentBridgeToolDefinition,
} from "./threadTools.ts";

const client = (
  scopes: ReadonlyArray<AgentBridgeScope> = AGENT_BRIDGE_SCOPES,
): AgentBridgeClientRecord => ({
  id: AGENT_BRIDGE_LOCAL_CLIENT_ID,
  kind: "local",
  name: "Local MCP client",
  label: null,
  scopes,
  projectIds: [],
  grantGeneration: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  redirectUris: [],
});

const caller = (scopes?: ReadonlyArray<AgentBridgeScope>): AgentBridgeCaller => ({
  client: client(scopes),
  visibleProjectIds: new Set(["exposed"]),
});

function makeTools(): ReadonlyArray<AgentBridgeToolDefinition> {
  const host = new FakeAgentBridgeHost();
  host.projects = [project("exposed"), project("hidden")];
  return makeThreadTools({
    host: host.shape,
    // Read-only fixtures never touch receipts.
    store: {} as AgentBridgeStore,
    limiters: makeAgentBridgeLimiters(),
  });
}

/** Recursive subset match: every key in `expected` must equal the same key in `actual`. */
function expectSubset(actual: unknown, expected: unknown): void {
  if (expected === null || typeof expected !== "object") {
    expect(actual).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(actual).toEqual(expected);
    return;
  }
  expect(actual).toBeTypeOf("object");
  for (const [key, value] of Object.entries(expected)) {
    expectSubset((actual as Record<string, unknown>)[key], value);
  }
}

describe("MCP conformance fixtures", () => {
  for (const fixture of [fixture20250618, fixture20260728]) {
    it(`replays the ${fixture.version} fixture`, async () => {
      const tools = makeTools();
      for (const exchange of fixture.exchanges as ReadonlyArray<{
        headers?: Record<string, string>;
        request: Record<string, unknown>;
        response?: unknown;
        toolNames?: ReadonlyArray<string>;
      }>) {
        const header = exchange.headers?.["mcp-protocol-version"];
        assertMcpVersion(exchange.request, header);
        const response = await Effect.runPromise(
          handleMcpRequest(exchange.request, tools, {
            caller: caller(),
            protocolVersionHeader: header,
            serverVersion: "0.0.0-test",
          }),
        );
        if (exchange.toolNames) {
          expect(
            (response as { result: { tools: Array<{ name: string }> } }).result.tools.map(
              (tool) => tool.name,
            ),
          ).toEqual(exchange.toolNames);
          continue;
        }
        expectSubset(response, exchange.response);
      }
    });
  }

  it("rejects an unsupported version header", () => {
    expect(() =>
      assertMcpVersion({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "2024-11-05"),
    ).toThrow(UnsupportedMcpVersionError);
  });

  it("hides tools outside the granted scopes and reports insufficient_scope", async () => {
    const tools = makeTools();
    const readOnly = caller(["f5.read"]);
    const listed = (await Effect.runPromise(
      handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools, {
        caller: readOnly,
        protocolVersionHeader: undefined,
        serverVersion: "0",
      }),
    )) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("create_thread");
    const called = (await Effect.runPromise(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "create_thread", arguments: { projectId: "exposed", prompt: "x" } },
        },
        tools,
        { caller: readOnly, protocolVersionHeader: undefined, serverVersion: "0" },
      ),
    )) as { result: { isError: boolean; _meta: Record<string, string> } };
    expect(called.result.isError).toBe(true);
    expect(called.result._meta["mcp/www_authenticate"]).toContain("insufficient_scope");
  });
});

describe("local listener", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start(tools: ReadonlyArray<AgentBridgeToolDefinition> = makeTools()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-agent-bridge-"));
    const credentialsPath = path.join(dir, "agent-bridge", "local.json");
    const listener = await startLocalListener({
      credentialsPath,
      resolveLocalCaller: async () => caller(),
      tools: () => tools,
      serverVersion: "0.0.0-test",
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await listener.close();
    };
    cleanups.push(close);
    return { listener, credentialsPath, close };
  }

  const post = (
    listener: LocalListener,
    init: { token?: string; path?: string; headers?: Record<string, string>; body?: unknown },
  ) =>
    fetch(`http://127.0.0.1:${listener.port}${init.path ?? "/mcp"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: JSON.stringify(init.body ?? { jsonrpc: "2.0", id: 1, method: "ping" }),
    });

  it("publishes local.json atomically with mode 0600 and removes it on close", async () => {
    const { listener, credentialsPath, close } = await start();
    const credentials = await readAgentBridgeLocalCredentials(credentialsPath);
    expect(credentials).toMatchObject({ port: listener.port, token: listener.token });
    expect(Buffer.from(listener.token, "base64url")).toHaveLength(32);
    // Windows reports 0o666 for any writable file; POSIX modes do not apply there.
    if (process.platform !== "win32") expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(
      fs.readdirSync(path.dirname(credentialsPath)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    await close();
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it("rotates the token on every start", async () => {
    const first = await start();
    const second = await start();
    expect(first.listener.token).not.toBe(second.listener.token);
  });

  it("enforces routes, credentials, origins, and versions", async () => {
    const { listener } = await start();
    expect((await post(listener, { token: listener.token })).status).toBe(200);
    expect((await post(listener, { token: listener.token, path: "/other" })).status).toBe(404);
    const missing = await post(listener, {});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    // An OAuth-style or master token is not the local token.
    expect((await post(listener, { token: "oauth-access-token" })).status).toBe(401);
    expect(
      (
        await post(listener, {
          token: listener.token,
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(listener, {
          token: listener.token,
          headers: { "mcp-protocol-version": "1999-01-01" },
        })
      ).status,
    ).toBe(400);
    const notification = await post(listener, {
      token: listener.token,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notification.status).toBe(202);
    const get = await fetch(`http://127.0.0.1:${listener.port}/mcp`, {
      headers: { authorization: `Bearer ${listener.token}` },
    });
    expect(get.status).toBe(405);
  });

  it("interrupts a running tool when the client disconnects", async () => {
    let interrupted = false;
    const slow: AgentBridgeToolDefinition = {
      ...makeTools()[0]!,
      name: "slow",
      run: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    };
    const { listener } = await start([slow]);
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${listener.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${listener.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "slow", arguments: {} },
      }),
      signal: controller.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await request;
    await expect.poll(() => interrupted, { timeout: 5_000 }).toBe(true);
  });
});

describe("agent-bridge-stdio", () => {
  async function runShim(
    lines: ReadonlyArray<unknown>,
    options: { credentialsPath: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch },
  ) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    const done = runAgentBridgeStdio({
      credentialsPath: options.credentialsPath,
      input,
      output,
      env: options.env ?? {},
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    for (const line of lines) input.write(`${JSON.stringify(line)}\n`);
    input.end();
    await done;
    return chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number; result?: any; error?: any });
  }

  it("serves no tools to F5's own agent processes", async () => {
    const replies = await runShim(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects" } },
      ],
      { credentialsPath: "/nonexistent/local.json", env: { F5_AGENT_PROCESS: "1" } },
    );
    expect(replies.find((reply) => reply.id === 2)?.result).toEqual({ tools: [] });
    expect(replies.find((reply) => reply.id === 3)?.error.code).toBe(AGENT_BRIDGE_UNAVAILABLE_CODE);
  });

  it("serves no tools when the F5 server is an ancestor, with no marker in the environment", async () => {
    // A stripped environment, as Codex gives stdio MCP servers. The shim walks
    // its real process tree: the test runner's parent stands in for F5.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-agent-bridge-ancestry-"));
    const credentialsPath = path.join(dir, "local.json");
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        port: 9,
        token: "t",
        startedAt: new Date().toISOString(),
        serverPid: process.ppid,
      }),
    );
    let forwarded = false;
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    const done = runAgentBridgeStdio({
      credentialsPath,
      input,
      output,
      env: {},
      fetch: (async () => {
        forwarded = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await done;
    expect(forwarded).toBe(false);
    expect(JSON.parse(chunks.join("").trim()).result).toEqual({ tools: [] });
  });

  it("finds ancestors by walking parent processes", () => {
    const parents = new Map([
      [40, 30],
      [30, 20],
      [20, 1],
    ]);
    const parentOf = (pid: number) => parents.get(pid) ?? null;
    expect(isAncestorProcess(20, 40, parentOf)).toBe(true);
    expect(isAncestorProcess(99, 40, parentOf)).toBe(false);
    // The real walk needs `ps` (macOS) or /proc (Linux); sandboxes may block both.
    if (parentProcessId(process.pid) === process.ppid) {
      expect(isAncestorProcess(process.ppid, process.pid)).toBe(true);
      expect(isAncestorProcess(2 ** 22 + 7, process.pid)).toBe(false);
    }
  });

  it("answers HTTP errors without a JSON-RPC envelope with an error for that request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-agent-bridge-http-error-"));
    const credentialsPath = path.join(dir, "local.json");
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ port: 9, token: "t", startedAt: new Date().toISOString() }),
    );
    const replies = await runShim([{ jsonrpc: "2.0", id: 7, method: "tools/list" }], {
      credentialsPath,
      fetch: (async () =>
        new Response(JSON.stringify({ error: "request_too_large" }), {
          status: 413,
        })) as unknown as typeof fetch,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(7);
    expect(replies[0]?.error.code).toBe(AGENT_BRIDGE_UNAVAILABLE_CODE);
    expect(replies[0]?.error.message).toContain("413");
  });

  it("returns -32002 when F5 or the bridge is down", async () => {
    const replies = await runShim([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], {
      credentialsPath: path.join(os.tmpdir(), `missing-${Date.now()}`, "local.json"),
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.error.code).toBe(AGENT_BRIDGE_UNAVAILABLE_CODE);
  });

  it("forwards each line to the local listener", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-agent-bridge-shim-"));
    const credentialsPath = path.join(dir, "local.json");
    const listener = await startLocalListener({
      credentialsPath,
      resolveLocalCaller: async () => caller(),
      tools: makeTools,
      serverVersion: "0.0.0-test",
    });
    try {
      const replies = await runShim(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18" },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "list_projects", arguments: {} },
          },
        ],
        { credentialsPath },
      );
      expect(replies).toHaveLength(2);
      expect(replies.find((reply) => reply.id === 1)?.result.protocolVersion).toBe("2025-06-18");
      expect(
        replies.find((reply) => reply.id === 2)?.result.structuredContent.projects,
      ).toHaveLength(1);
    } finally {
      await listener.close();
    }
  });
});
