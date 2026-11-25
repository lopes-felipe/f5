import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ProjectId,
  ThreadId,
  type McpProjectServersConfig,
  type McpStatusUpdatedPayload,
} from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../PreviewAutomationBroker.ts";
import {
  makePreviewMcpHttpServer,
  type PreviewMcpHttpServerShape,
} from "../PreviewMcpHttpServer.ts";
import { defaultConnectionScope, makeMcpHub, type McpHubShape } from "./McpHub.ts";
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
  await hub.close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await rm(root, { recursive: true, force: true });
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

function attach(servers: McpProjectServersConfig, threadId = "thread-1", reserved?: string[]) {
  return hub.attach({
    threadId: ThreadId.makeUnsafe(threadId),
    projectId,
    provider: "grok",
    accountKey: "grok",
    servers,
    environment: { PATH: process.env.PATH ?? "" },
    cwd: root,
    ...(reserved ? { reservedNames: new Set(reserved) } : {}),
  });
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
    expect(tools.tools.map((tool) => tool.name)).toEqual(["echo", "slow", "add_tool", "ask"]);

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
    expect(observed.roots[0]?.uri).toBe(`file://${root}`);

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
      // Turned off for this provider: left out silently, even with an unset variable.
      notForGrok: {
        type: "http",
        url: "http://127.0.0.1:9/${env:UNSET_FOR_GROK}",
        disabledProviders: ["grok"],
      },
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

  it("resolves ${env:} from the account environment and omits a server with an unset variable", async () => {
    const attachment = attach({
      resolved: { type: "http", url: "https://${env:HOST:-resolved.example}/mcp" },
      unresolved: { type: "http", url: "https://example.test/mcp?k=${env:MISSING_KEY}" },
    } as unknown as McpProjectServersConfig);
    try {
      expect(attachment.endpoints.map((endpoint) => endpoint.serverName)).toEqual(["resolved"]);
      expect(attachment.omitted).toEqual([
        {
          serverName: "unresolved",
          reason: "needs the environment variable MISSING_KEY, which is not set",
        },
      ]);
    } finally {
      await attachment.dispose();
    }
  });

  it("applies saved changes to a live session's endpoints without a new endpoint", async () => {
    const attachment = attach(stdioServers());
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("slow");
      let changes = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        changes += 1;
      });

      // Unchanged definitions keep their connection.
      expect(attachment.update(stdioServers())).toEqual({
        changed: [],
        removed: [],
        added: [],
        addedEndpoints: [],
        endpoints: [endpoint],
        omitted: [],
      });

      // A changed definition moves the same endpoint to a new connection.
      const edited = {
        fixture: { ...stdioServers().fixture!, disabledTools: ["hidden", "slow"] },
        later: { type: "stdio" as const, command: process.execPath, args: [fixture] },
      };
      expect(attachment.update(edited)).toEqual({
        changed: ["fixture"],
        removed: [],
        added: ["later"],
        addedEndpoints: [],
        endpoints: [endpoint],
        omitted: [],
      });
      await expect.poll(() => changes).toBeGreaterThan(0);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "echo",
        "add_tool",
        "ask",
      ]);
      expect(hub.status(projectId)).toHaveLength(1);

      // A removed server lists nothing and refuses calls on the kept endpoint.
      const removal = attachment.update({});
      expect(removal.removed).toEqual(["fixture"]);
      expect(removal.endpoints).toEqual([]);
      expect((await client.listTools()).tools).toEqual([]);
      const refused = await client.callTool({ name: "echo", arguments: { text: "x" } });
      expect(refused.isError).toBe(true);
      expect(hub.status(projectId)).toEqual([]);

      // Saving it again routes the endpoint to a fresh connection.
      expect(attachment.update(stdioServers()).changed).toEqual(["fixture"]);
      const echoed = await client.callTool({ name: "echo", arguments: { text: "back" } });
      expect(echoed.content).toEqual([{ type: "text", text: "echo:back" }]);

      // Providers that take new servers mid-session get endpoints for them.
      const growth = attachment.update(edited, { addEndpoints: true });
      expect(growth.added).toEqual(["later"]);
      expect(growth.addedEndpoints.map((entry) => entry.serverName)).toEqual(["later"]);
      expect(growth.endpoints.map((entry) => entry.serverName)).toEqual(["fixture", "later"]);
      expect(attachment.endpoints).toHaveLength(2);
      const added = growth.addedEndpoints[0]!;
      const laterClient = await connect(added.url, added.token);
      const laterEcho = await laterClient.callTool({ name: "echo", arguments: { text: "new" } });
      expect(laterEcho.content).toEqual([{ type: "text", text: "echo:new" }]);
      await laterClient.close();
      // A later update sees the added server as already present.
      expect(attachment.update(edited, { addEndpoints: true }).added).toEqual([]);
    } finally {
      await attachment.dispose();
    }
  });

  it("lets MCP Apps reach a conversation's hub server directly", async () => {
    const attachment = attach(stdioServers(), "apps-thread");
    try {
      const server = hub.sessionServer!(ThreadId.makeUnsafe("apps-thread"), "fixture")!;
      expect(server).toBeDefined();
      expect(hub.sessionServer!(ThreadId.makeUnsafe("other-thread"), "fixture")).toBeUndefined();
      const tools = (await server.appListTools()).map((tool) => tool.name);
      expect(tools).toContain("echo");
      expect(tools).not.toContain("hidden");
      const signal = new AbortController().signal;
      const called = await server.appCallTool("echo", { text: "app" }, signal);
      expect(called.content).toEqual([{ type: "text", text: "echo:app" }]);
      await expect(server.appCallTool("hidden", {}, signal)).rejects.toThrow(/turned off/);
      const read = await server.appReadResource("fixture://readme", signal);
      expect(read.contents[0]).toMatchObject({ text: "fixture readme" });
    } finally {
      await attachment.dispose();
    }
    expect(hub.sessionServer!(ThreadId.makeUnsafe("apps-thread"), "fixture")).toBeUndefined();
  });

  it("forwards a server's question to the provider whose call is waiting", async () => {
    const attachment = attach(stdioServers());
    try {
      const endpoint = attachment.endpoints[0]!;
      const asking = new Client(
        { name: "provider", version: "1" },
        { capabilities: { elicitation: {} } },
      );
      asking.setRequestHandler(ElicitRequestSchema, (request) => {
        expect(request.params.message).toBe("Pick a color");
        return { action: "accept" as const, content: { color: "teal" } };
      });
      await asking.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
        }) as Transport,
      );
      clients.push(asking);
      const answered = await asking.callTool({ name: "ask", arguments: {} });
      expect(answered.content).toEqual([{ type: "text", text: "accept:teal" }]);

      // A provider connection without elicitation gets a declined question.
      const plain = await connect(endpoint.url, endpoint.token);
      const declined = await plain.callTool({ name: "ask", arguments: {} });
      expect(declined.content).toEqual([{ type: "text", text: "decline:" }]);
    } finally {
      await attachment.dispose();
    }
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
});
