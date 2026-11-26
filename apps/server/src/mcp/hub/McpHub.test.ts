import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ProjectId,
  ThreadId,
  type McpProjectServersConfig,
  type McpStatusUpdatedPayload,
} from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../PreviewAutomationBroker.ts";
import {
  makePreviewMcpHttpServer,
  type PreviewMcpHttpServerShape,
} from "../PreviewMcpHttpServer.ts";
import {
  defaultConnectionScope,
  describeMcpHubOmissions,
  makeMcpHub,
  type McpHubShape,
} from "./McpHub.ts";
import { HUB_SHARED_IDLE_MS, reconnectDelayMs } from "./McpHubUpstream.ts";

const fixture = fileURLToPath(new URL("../fixtures/hub-server.mjs", import.meta.url));
const projectId = ProjectId.makeUnsafe("hub-project");
const SECRET = "fixture-secret-value-123";

let scope: Scope.Closeable;
let listener: PreviewMcpHttpServerShape;
let hub: McpHubShape;
let events: McpStatusUpdatedPayload[];
let root: string;
const clients: Client[] = [];
const remoteFixtures: HttpServer[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "f5-mcp-hub-")));
  scope = Effect.runSync(Scope.make());
  listener = await Effect.runPromise(
    makePreviewMcpHttpServer.pipe(
      Effect.provideService(PreviewAutomationBroker, makePreviewAutomationBroker()),
      Scope.provide(scope),
    ),
  );
  events = [];
  hub = makeMcpHub({ listener, publish: (payload) => events.push(payload) });
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  vi.useRealTimers();
  await hub.close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const http of remoteFixtures.splice(0)) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  // Windows keeps a just-exited child's working directory locked for a moment.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function stdioServers(report?: string): McpProjectServersConfig {
  return {
    fixture: {
      type: "stdio",
      command: process.execPath,
      args: [fixture, ...(report ? [report] : [])],
      env: { HUB_FIXTURE_TOKEN: SECRET },
      disabledTools: ["hidden"],
    },
  };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "provider", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  clients.push(client);
  return client;
}

function attach(
  servers: McpProjectServersConfig,
  threadId = "thread-1",
  reserved?: string[],
  cwd = root,
) {
  return hub.attach({
    threadId: ThreadId.makeUnsafe(threadId),
    projectId,
    provider: "grok",
    accountKey: "grok",
    servers,
    environment: { PATH: process.env.PATH ?? "" },
    cwd,
    ...(reserved ? { reservedNames: new Set(reserved) } : {}),
  });
}

/**
 * A stateless streamable HTTP MCP server whose tool names and failure status can
 * change between requests, to model a restart (404), a revoked credential (401)
 * or an upgrade that changes the catalog.
 */
async function startRemoteFixture() {
  const state: { tools: string[]; failWith: number | undefined } = {
    tools: ["one"],
    failWith: undefined,
  };
  const http = createServer(async (req, res) => {
    if (state.failWith !== undefined) {
      res.writeHead(state.failWith).end("unavailable");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const server = new Server(
      { name: "remote-fixture", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: state.tools.map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => ({
      content: [{ type: "text", text: `called:${request.params.name}` }],
    }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, () => {
      throw new McpError(-32002, `lookup failed for ${SECRET}`, { echoed: { header: SECRET } });
    });
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => void Promise.allSettled([transport.close(), server.close()]));
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  remoteFixtures.push(http);
  return { state, url: `http://127.0.0.1:${port}/mcp` };
}

describe("F5 MCP hub", () => {
  it("serves a stdio server's tools, resources and prompts through a loopback endpoint", async () => {
    const report = join(root, "report.json");
    const attachment = await attach(stdioServers(report));
    expect(attachment.endpoints).toHaveLength(1);
    const endpoint = attachment.endpoints[0]!;
    expect(endpoint.serverName).toBe("fixture");
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/user\//u);
    expect(attachment.credentials).toEqual([endpoint.token]);
    // Lazy: nothing connects until the provider asks.
    expect(hub.status()[0]?.state).toBe("idle");

    const client = await connect(endpoint.url, endpoint.token);
    expect(client.getServerVersion()?.name).toBe("fixture");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["echo", "slow", "add_tool"]);

    const echoed = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(echoed.content).toEqual([{ type: "text", text: "echo:hi" }]);
    const blocked = await client.callTool({ name: "hidden", arguments: {} });
    expect(blocked.isError).toBe(true);

    const progress: number[] = [];
    const slow = await client.callTool({ name: "slow", arguments: {} }, undefined, {
      onprogress: (value) => progress.push(value.progress),
    });
    expect(slow.content).toEqual([{ type: "text", text: "done" }]);
    expect(progress).toEqual([1, 2, 3]);

    const resource = await client.readResource({ uri: "fixture://readme" });
    expect(resource.contents[0]).toMatchObject({ text: "fixture readme" });
    expect((await client.listResources()).resources).toHaveLength(1);
    const prompt = await client.getPrompt({ name: "greet", arguments: { who: "F5" } });
    expect(prompt.messages[0]?.content).toEqual({ type: "text", text: "Hello F5" });

    // Roots and the default working directory are the conversation's.
    const observed = JSON.parse(await readFile(report, "utf8")) as {
      cwd: string;
      roots: Array<{ uri: string }>;
    };
    expect(observed.cwd).toBe(root);
    expect(observed.roots[0]?.uri).toBe(pathToFileURL(root).href);

    const [status] = hub.status(projectId);
    expect(status).toMatchObject({
      name: "fixture",
      connectionScope: "session",
      transport: "stdio",
      state: "ready",
      serverInfo: { name: "hub-fixture", version: "2.0.0" },
      attachedSessions: 1,
      projectIds: [projectId],
      providers: ["grok"],
    });
    expect(hub.readStderrTail("fixture")).toContain("hub fixture started");
    expect(hub.readStderrTail("fixture")).not.toContain(SECRET);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toContainEqual({ scope: "common", reason: "hub", serverName: "fixture" });

    await attachment.dispose();
    expect(hub.status()).toEqual([]);
  });

  it("rejects missing, wrong and revoked credentials", async () => {
    const attachment = await attach(stdioServers());
    const endpoint = attachment.endpoints[0]!;
    const post = (token: string | null) =>
      fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    expect((await post(null)).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    // A browser origin never reaches the hub.
    const fromBrowser = await fetch(endpoint.url, {
      method: "POST",
      headers: { origin: "https://example.com", authorization: `Bearer ${endpoint.token}` },
      body: "{}",
    });
    expect(fromBrowser.status).toBe(403);
    await attachment.dispose();
    expect((await post(endpoint.token)).status).toBe(401);
  });

  it("forwards tools/list_changed from the upstream", async () => {
    const attachment = await attach(stdioServers());
    const endpoint = attachment.endpoints[0]!;
    const client = await connect(endpoint.url, endpoint.token);
    let notified = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
    });
    await client.listTools();
    await client.callTool({ name: "add_tool", arguments: {} });
    await expect.poll(() => notified).toBe(true);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("added");
    await attachment.dispose();
  });

  it("shares remote connections per account and skips reserved and disabled servers", async () => {
    const servers: McpProjectServersConfig = {
      remote: { type: "http", url: "http://127.0.0.1:9/mcp" },
      off: { type: "http", url: "http://127.0.0.1:9/off", enabled: false },
      f5_thread: { type: "http", url: "http://127.0.0.1:9/thread" },
    };
    const first = await attach(servers, "thread-a", ["f5_thread"]);
    const second = await attach(servers, "thread-b", ["f5_thread"]);
    expect(first.endpoints.map((endpoint) => endpoint.serverName)).toEqual(["remote"]);
    expect(first.omitted).toEqual([
      { serverName: "f5_thread", reason: "uses a name the provider already has" },
    ]);
    expect(first.endpoints[0]!.url).not.toBe(second.endpoints[0]!.url);
    expect(hub.status()).toEqual([
      expect.objectContaining({ name: "remote", connectionScope: "shared", attachedSessions: 2 }),
    ]);
    await first.dispose();
    await second.dispose();
    // Shared connections idle for five minutes before stopping, so status still lists it.
    expect(hub.status()[0]).toMatchObject({ name: "remote", attachedSessions: 0 });
  });

  it("returns a tool error and backs off when the upstream cannot start", async () => {
    const attachment = await attach({
      broken: { type: "stdio", command: join(root, "missing-command") },
    });
    const endpoint = attachment.endpoints[0]!;
    const client = await connect(endpoint.url, endpoint.token);
    const result = await client.callTool({ name: "anything", arguments: {} });
    expect(result.isError).toBe(true);
    await expect.poll(() => hub.status()[0]?.state).toBe("retrying");
    expect(hub.status()[0]?.attempts).toBeGreaterThanOrEqual(1);
    expect(hub.status()[0]?.error).toBeTruthy();
    // While retrying, calls fail with the last error instead of hanging.
    const again = await client.callTool({ name: "anything", arguments: {} });
    expect(again.isError).toBe(true);
    await attachment.dispose();
  });

  it("omits every server when no listener can mount hub endpoints", async () => {
    const detached = makeMcpHub({});
    const attachment = await detached.attach({
      threadId: ThreadId.makeUnsafe("thread"),
      provider: "pi",
      accountKey: "pi",
      servers: stdioServers(),
      environment: {},
      cwd: root,
    });
    expect(detached.available).toBe(false);
    expect(attachment.endpoints).toEqual([]);
    expect(attachment.omitted[0]?.serverName).toBe("fixture");
  });

  it("reconnects a shared remote connection whose session expired and refreshes its tools", async () => {
    const remote = await startRemoteFixture();
    const attachment = await attach({ remote: { type: "http", url: remote.url } });
    const endpoint = attachment.endpoints[0]!;
    const client = await connect(endpoint.url, endpoint.token);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["one"]);
    let notified = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
    });

    // The server restarts onto a build with other tools; the old session is gone.
    remote.state.failWith = 404;
    remote.state.tools = ["two"];
    const failed = await client.callTool({ name: "one", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(hub.status()[0]?.state).not.toBe("ready");

    remote.state.failWith = undefined;
    await expect.poll(() => hub.status()[0]?.state, { timeout: 5_000 }).toBe("ready");
    await expect.poll(() => notified).toBe(true);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["two"]);
    expect(hub.status()[0]?.toolCount).toBe(1);
    await attachment.dispose();
  });

  it("moves a remote connection to needs-auth when its credential is rejected after initialize", async () => {
    const remote = await startRemoteFixture();
    const attachment = await attach({ remote: { type: "http", url: remote.url } });
    const endpoint = attachment.endpoints[0]!;
    const client = await connect(endpoint.url, endpoint.token);
    await client.listTools();
    remote.state.failWith = 401;
    const failed = await client.callTool({ name: "one", arguments: {} });
    expect(failed.isError).toBe(true);
    await expect.poll(() => hub.status()[0]?.state).toBe("needs-auth");
    await attachment.dispose();
  });

  it("redacts upstream error messages and drops their structured data", async () => {
    const remote = await startRemoteFixture();
    const attachment = await attach({
      remote: { type: "http", url: remote.url, headers: { "X-Api-Key": SECRET } },
    });
    const endpoint = attachment.endpoints[0]!;
    const client = await connect(endpoint.url, endpoint.token);
    const error = await client.readResource({ uri: "fixture://x" }).then(
      () => undefined,
      (cause: unknown) => cause as McpError,
    );
    expect(error).toBeInstanceOf(McpError);
    expect(error!.code).toBe(-32002);
    expect(error!.message).not.toContain(SECRET);
    expect(error!.data).toBeUndefined();
    await attachment.dispose();
  });

  it("keeps one shared connection per workspace folder", async () => {
    const otherRoot = join(root, "other");
    const servers: McpProjectServersConfig = {
      remote: { type: "http", url: "http://127.0.0.1:9/mcp" },
    };
    const first = await attach(servers, "thread-a");
    const second = await attach(servers, "thread-b", undefined, otherRoot);
    const third = await attach(servers, "thread-c");
    const statuses = hub.status(projectId);
    expect(statuses).toHaveLength(2);
    expect(new Set(statuses.map((status) => status.id)).size).toBe(2);
    expect(statuses.map((status) => status.attachedSessions).sort()).toEqual([1, 2]);
    await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  });

  it("removes an idle shared connection when its idle timer fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attachment = await attach({ remote: { type: "http", url: "http://127.0.0.1:9/mcp" } });
    await attachment.dispose();
    expect(hub.status()).toEqual([
      expect.objectContaining({ name: "remote", state: "idle", attachedSessions: 0 }),
    ]);
    await vi.advanceTimersByTimeAsync(HUB_SHARED_IDLE_MS);
    expect(hub.status()).toEqual([]);
  });
});

describe("hub defaults", () => {
  it("uses session scope for stdio and shared scope for remote servers unless set", () => {
    expect(defaultConnectionScope({ type: "stdio", command: "x" })).toBe("session");
    expect(defaultConnectionScope({ type: "http", url: "https://x" })).toBe("shared");
    expect(
      defaultConnectionScope({ type: "sse", url: "https://x", connectionScope: "session" }),
    ).toBe("session");
  });

  it("backs off from one second, doubling to thirty, and idles shared connections for five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(HUB_SHARED_IDLE_MS).toBe(300_000);
  });

  it("describes omitted servers for the conversation warning", () => {
    expect(describeMcpHubOmissions("Pi", [])).toBeUndefined();
    expect(
      describeMcpHubOmissions("Grok", [
        { serverName: "docs", reason: "uses a name the provider already has" },
      ]),
    ).toEqual({
      summary: "F5 did not pass MCP server docs to Grok.",
      details: "docs uses a name the provider already has.",
    });
    expect(
      describeMcpHubOmissions("OpenCode", [
        { serverName: "a", reason: "could not be added to OpenCode" },
        { serverName: "b", reason: "could not be added to OpenCode" },
      ])?.summary,
    ).toBe("F5 did not pass 2 MCP servers to OpenCode.");
  });
});
