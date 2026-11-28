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
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
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
  type McpServerDefinition,
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
import type {
  McpHubGovernance,
  McpToolApprovalDecision,
  McpToolApprovalInput,
  McpToolCallLogEntry,
} from "./McpHubGovernance.ts";
import { withoutProviderMeta } from "./McpHubEndpoint.ts";
import { HUB_SHARED_IDLE_MS, reconnectDelayMs } from "./McpHubUpstream.ts";
import {
  flattenPrompt,
  listComposerPrompts,
  listComposerResources,
  shapeResourceContents,
} from "./mcpComposerContext.ts";
import { memoryOAuthStorage, mcpOAuthKey } from "./McpOAuth.ts";

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

/** The stdio fixture with extra settings, such as a tool policy. */
function withFixture(
  extra: Pick<
    McpServerDefinition,
    "toolPolicy" | "defaultToolPolicy" | "disabledTools" | "enabledTools"
  >,
): McpProjectServersConfig {
  return { fixture: { ...stdioServers().fixture!, ...extra } };
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

/** Replaces the default hub (one hub mounts the listener) with one using `governance`. */
async function useGovernedHub(governance: McpHubGovernance): Promise<McpHubShape> {
  await hub.close();
  hub = makeMcpHub({ listener, governance });
  return hub;
}

/** In-memory governance: scripted answers, a set of changed tools, and recorded calls. */
function makeFakeGovernance() {
  const answers: McpToolApprovalDecision[] = [];
  const asked: Omit<McpToolApprovalInput, "signal">[] = [];
  const calls: McpToolCallLogEntry[] = [];
  const observed: string[] = [];
  const changed = new Set<string>();
  const allowances = new Set<string>();
  const disabled = new Set<string>();
  const listeners = new Set<(threadId: ThreadId) => void>();
  // Tools of the first listing are pinned; any tool seen later is new.
  let firstListing: Set<string> | undefined;
  const hooks: { onAsk?: (() => void) | undefined } = {};
  const governance: McpHubGovernance = {
    observeTools: (_server, _identity, tools) => {
      firstListing ??= new Set(tools.map((tool) => tool.name));
      observed.push(...tools.map((tool) => tool.name));
    },
    pinState: (_server, _identity, tool) =>
      changed.has(tool)
        ? "changed"
        : firstListing && !firstListing.has(tool) && observed.includes(tool)
          ? "new"
          : "pinned",
    acceptedDescription: (_identity, tool) => (changed.has(tool) ? "Accepted text" : undefined),
    requestApproval: async ({ signal: _signal, ...input }) => {
      asked.push(input);
      hooks.onAsk?.();
      return answers.shift() ?? "decline";
    },
    allowedForSession: (threadId, server, tool, identity) =>
      allowances.has(`${threadId}/${server}/${identity}/${tool}`),
    allowForSession: (threadId, server, tool, identity) => {
      allowances.add(`${threadId}/${server}/${identity}/${tool}`);
    },
    clearSessionAllowances: (threadId, server) => {
      for (const key of allowances)
        if (key.startsWith(`${threadId}/${server}/`)) allowances.delete(key);
    },
    isServerDisabled: (threadId, server) => disabled.has(`${threadId}/${server}`),
    onThreadServersChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordCall: (entry) => calls.push(entry),
  };
  return {
    ...governance,
    answers,
    asked,
    calls,
    observed,
    changed,
    hooks,
    disable: (threadId: ThreadId, server: string) => {
      disabled.add(`${threadId}/${server}`);
      for (const listener of listeners) listener(threadId);
    },
  };
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
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "slow",
      "add_tool",
      "ask",
      "ask_url",
      "wait",
    ]);

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
        timeoutRaised: [],
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
        timeoutRaised: [],
      });
      await expect.poll(() => changes).toBeGreaterThan(0);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "echo",
        "add_tool",
        "ask",
        "ask_url",
        "wait",
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

  it("gives the composer a conversation's prompts and resources", async () => {
    const attachment = attach(stdioServers(), "composer-thread");
    try {
      expect(hub.sessionServers!(ThreadId.makeUnsafe("other-thread")).size).toBe(0);
      const servers = hub.sessionServers!(ThreadId.makeUnsafe("composer-thread"));
      expect([...servers.keys()]).toEqual(["fixture"]);
      expect(await listComposerPrompts(servers)).toEqual([
        {
          serverName: "fixture",
          prompts: [{ name: "greet", arguments: [{ name: "who", required: true }] }],
        },
      ]);
      expect(await listComposerResources(servers)).toEqual([
        {
          serverName: "fixture",
          resources: [{ uri: "fixture://readme", name: "Readme", mimeType: "text/plain" }],
          truncated: false,
        },
      ]);
      const signal = new AbortController().signal;
      const server = servers.get("fixture")!;
      expect(
        flattenPrompt(await server.getPrompt({ name: "greet", arguments: { who: "F5" } }, signal)),
      ).toEqual({ text: "Hello F5", omitted: 0 });
      expect(
        shapeResourceContents(await server.readResource({ uri: "fixture://readme" }, signal)),
      ).toEqual({
        contents: [
          {
            kind: "text",
            uri: "fixture://readme",
            mimeType: "text/plain",
            text: "fixture readme",
            truncated: false,
          },
        ],
        omitted: 0,
      });
    } finally {
      await attachment.dispose();
    }
    expect(hub.sessionServers!(ThreadId.makeUnsafe("composer-thread")).size).toBe(0);
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

  it("asks before Ask-policy and changed tools, and remembers an answer for the conversation", async () => {
    const governance = makeFakeGovernance();
    const governed = await useGovernedHub(governance);
    const servers = withFixture({ toolPolicy: { echo: "ask" } });
    const attachment = governed.attach({
      threadId: ThreadId.makeUnsafe("policy-thread"),
      projectId,
      provider: "codex",
      accountKey: "codex",
      servers,
      environment: { PATH: process.env.PATH ?? "" },
      cwd: root,
    });
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      await client.listTools();
      expect(governance.observed).toContain("echo");
      expect(attachment.asksBeforeCall!("fixture", "echo")).toBe(true);
      expect(attachment.asksBeforeCall!("fixture", "slow")).toBe(false);

      governance.answers.push("decline");
      const declined = await client.callTool({ name: "echo", arguments: { text: "no" } });
      expect(declined).toMatchObject({ isError: true });
      expect(JSON.stringify(declined.content)).toContain("declined");
      expect(governance.asked.at(-1)).toMatchObject({
        provider: "codex",
        serverName: "fixture",
        toolName: "echo",
        reason: "policy",
      });

      governance.answers.push("acceptForSession");
      const allowed = await client.callTool({ name: "echo", arguments: { text: "yes" } });
      expect(allowed.content).toEqual([{ type: "text", text: "echo:yes" }]);
      // Allowed for this conversation: no second question, and no provider prompt either.
      const again = await client.callTool({ name: "echo", arguments: { text: "again" } });
      expect(again.content).toEqual([{ type: "text", text: "echo:again" }]);
      expect(governance.asked).toHaveLength(2);
      expect(attachment.asksBeforeCall!("fixture", "echo")).toBe(false);

      // A changed tool asks even under Allow, and never offers "for this conversation".
      governance.changed.add("slow");
      expect(attachment.asksBeforeCall!("fixture", "slow")).toBe(true);
      governance.answers.push("accept");
      await client.callTool({ name: "slow", arguments: {} });
      expect(governance.asked.at(-1)).toMatchObject({ toolName: "slow", reason: "changed" });

      await client.callTool({ name: "hidden", arguments: {} });
      expect(governance.calls.map((call) => [call.toolName, call.outcome, call.approval])).toEqual([
        ["echo", "declined", "asked"],
        ["echo", "ok", "asked"],
        ["echo", "ok", "session"],
        ["slow", "ok", "asked"],
        ["hidden", "blocked", "policy"],
      ]);
      expect(governance.calls.every((call) => call.projectId === projectId)).toBe(true);
    } finally {
      await attachment.dispose();
      await governed.close();
    }
  });

  it("applies a saved policy change without reconnecting the server", async () => {
    const governance = makeFakeGovernance();
    const governed = await useGovernedHub(governance);
    const attachment = governed.attach({
      threadId: ThreadId.makeUnsafe("policy-update"),
      provider: "grok",
      accountKey: "grok",
      servers: stdioServers(),
      environment: { PATH: process.env.PATH ?? "" },
      cwd: root,
    });
    try {
      expect(attachment.asksBeforeCall!("fixture", "echo")).toBe(false);
      const update = attachment.update(withFixture({ defaultToolPolicy: "ask" }));
      expect(update.changed).toEqual([]);
      expect(attachment.asksBeforeCall!("fixture", "echo")).toBe(true);
      // A save reaches every live session of the project without Apply.
      expect(governed.attachedProjects!()).toEqual([undefined]);
      governed.refreshToolPolicies!(projectId, withFixture({}));
      expect(attachment.asksBeforeCall!("fixture", "echo")).toBe(true);
      governed.refreshToolPolicies!(undefined, withFixture({ toolPolicy: { echo: "allow" } }));
      expect(attachment.asksBeforeCall!("fixture", "echo")).toBe(false);
    } finally {
      await attachment.dispose();
      await governed.close();
    }
  });

  it("hides a server turned off for one conversation and refuses its calls", async () => {
    const governance = makeFakeGovernance();
    const governed = await useGovernedHub(governance);
    const attachment = governed.attach({
      threadId: ThreadId.makeUnsafe("toggle-thread"),
      provider: "grok",
      accountKey: "grok",
      servers: stdioServers(),
      environment: { PATH: process.env.PATH ?? "" },
      cwd: root,
    });
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const changed = new Promise<void>((resolve) =>
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
      );
      governance.disable(ThreadId.makeUnsafe("toggle-thread"), "fixture");
      await changed;
      expect((await client.listTools()).tools).toEqual([]);
      const refused = await client.callTool({ name: "echo", arguments: {} });
      expect(JSON.stringify(refused.content)).toContain("turned off for this conversation");
      expect(governance.calls.at(-1)).toMatchObject({ outcome: "turned-off" });
      // Prompts and resources go with it, for the provider and the composer alike.
      expect((await client.listPrompts()).prompts).toEqual([]);
      expect((await client.listResources()).resources).toEqual([]);
      await expect(client.readResource({ uri: "fixture://readme" })).rejects.toThrow(
        /turned off for this conversation/,
      );
      const servers = governed.sessionServers!(ThreadId.makeUnsafe("toggle-thread"));
      expect((await listComposerPrompts(servers))[0]?.prompts).toEqual([]);
    } finally {
      await attachment.dispose();
      await governed.close();
    }
  });

  it("checks pins against the server's current tools, even when the provider never re-lists", async () => {
    const governance = makeFakeGovernance();
    const governed = await useGovernedHub(governance);
    const attachment = governed.attach({
      threadId: ThreadId.makeUnsafe("pin-thread"),
      provider: "grok",
      accountKey: "grok",
      servers: stdioServers(),
      environment: { PATH: process.env.PATH ?? "" },
      cwd: root,
    });
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      await client.listTools();
      // The server adds a tool and says its list changed; the provider calls it directly.
      await client.callTool({ name: "add_tool", arguments: {} });
      const answer = await client.callTool({ name: "added", arguments: {} });
      expect(JSON.stringify(answer.content)).toContain("declined");
      expect(governance.asked.at(-1)).toMatchObject({ toolName: "added", reason: "new" });

      // A changed tool is listed with its accepted description until it is reviewed.
      governance.changed.add("slow");
      const slow = (await client.listTools()).tools.find((tool) => tool.name === "slow");
      expect(slow?.description).toBe("Accepted text");
    } finally {
      await attachment.dispose();
      await governed.close();
    }
  });

  it("re-checks the toggle after an approval wait and blocks tools as soon as they are saved", async () => {
    const governance = makeFakeGovernance();
    const governed = await useGovernedHub(governance);
    const threadId = ThreadId.makeUnsafe("recheck-thread");
    const attachment = governed.attach({
      threadId,
      provider: "grok",
      accountKey: "grok",
      servers: withFixture({ toolPolicy: { echo: "ask" } }),
      environment: { PATH: process.env.PATH ?? "" },
      cwd: root,
    });
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      // The user turns the server off while the approval card is open, then accepts it.
      governance.hooks.onAsk = () => governance.disable(threadId, "fixture");
      governance.answers.push("accept");
      const refused = await client.callTool({ name: "echo", arguments: { text: "late" } });
      expect(JSON.stringify(refused.content)).toContain("turned off for this conversation");
      expect(governance.calls.at(-1)).toMatchObject({ toolName: "echo", outcome: "turned-off" });
    } finally {
      await attachment.dispose();
    }

    const second = governed.attach({
      threadId: ThreadId.makeUnsafe("block-thread"),
      provider: "grok",
      accountKey: "grok",
      servers: withFixture({ toolPolicy: { echo: "ask" } }),
      environment: { PATH: process.env.PATH ?? "" },
      cwd: root,
    });
    try {
      const endpoint = second.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      governance.hooks.onAsk = undefined;
      governance.answers.push("acceptForSession");
      await client.callTool({ name: "echo", arguments: { text: "a" } });
      expect(second.asksBeforeCall!("fixture", "echo")).toBe(false);
      // Saving a policy change ends the conversation allowance.
      governed.refreshToolPolicies!(
        undefined,
        withFixture({ toolPolicy: { echo: "ask", slow: "ask" } }),
      );
      expect(second.asksBeforeCall!("fixture", "echo")).toBe(true);
      // Saving Block hides the tool and refuses its calls without Apply.
      governed.refreshToolPolicies!(undefined, withFixture({ disabledTools: ["hidden", "echo"] }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("echo");
      const blocked = await client.callTool({ name: "echo", arguments: { text: "b" } });
      expect(JSON.stringify(blocked.content)).toContain("turned off in F5's MCP settings");
    } finally {
      await second.dispose();
      await governed.close();
    }
  });

  it("never forwards a provider's reserved meta from a server's question", () => {
    expect(
      withoutProviderMeta({
        message: "Allow?",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "x", trace: "t" },
      }),
    ).toEqual({ message: "Allow?", _meta: { tool_name: "x", trace: "t" } });
    const plain = { message: "Pick", _meta: { trace: "t" } };
    expect(withoutProviderMeta(plain)).toBe(plain);
  });

  it("refuses Ask-policy tools when nobody can be asked", async () => {
    const attachment = attach(withFixture({ defaultToolPolicy: "ask" }), "ungoverned");
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      const refused = await client.callTool({ name: "echo", arguments: {} });
      expect(refused).toMatchObject({ isError: true });
      expect(JSON.stringify(refused.content)).toContain("cannot ask");
    } finally {
      await attachment.dispose();
    }
  });

  it("forwards a URL-mode question and its completion notice to the provider that showed it", async () => {
    const attachment = attach(stdioServers());
    try {
      const endpoint = attachment.endpoints[0]!;
      const completed: string[] = [];
      const asking = new Client(
        { name: "provider", version: "1" },
        { capabilities: { elicitation: { form: {}, url: {} } } },
      );
      asking.setRequestHandler(ElicitRequestSchema, (request) => {
        expect(request.params).toMatchObject({ mode: "url", url: "https://example.test/finish" });
        return { action: "accept" as const };
      });
      asking.setNotificationHandler(ElicitationCompleteNotificationSchema, (notification) => {
        completed.push(notification.params.elicitationId);
      });
      await asking.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
        }) as Transport,
      );
      clients.push(asking);
      const answered = await asking.callTool({ name: "ask_url", arguments: {} });
      expect(answered.content).toEqual([{ type: "text", text: "url:accept" }]);
      await expect.poll(() => completed).toEqual(["fixture-elicitation"]);

      // A provider that only takes forms gets the URL question declined.
      const formOnly = new Client(
        { name: "provider", version: "1" },
        { capabilities: { elicitation: {} } },
      );
      formOnly.setRequestHandler(ElicitRequestSchema, () => ({ action: "accept" as const }));
      await formOnly.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
        }) as Transport,
      );
      clients.push(formOnly);
      const declined = await formOnly.callTool({ name: "ask_url", arguments: {} });
      expect(declined.content).toEqual([{ type: "text", text: "url:decline" }]);
    } finally {
      await attachment.dispose();
    }
  });

  it("never forwards a question from one conversation's app call to another conversation", async () => {
    const shared = {
      fixture: { ...stdioServers().fixture!, connectionScope: "shared" as const },
    };
    const first = attach(shared, "thread-a");
    const second = attach(shared, "thread-b");
    try {
      expect(hub.status(projectId)).toHaveLength(1);
      const endpoint = second.endpoints[0]!;
      let asked = 0;
      const provider = new Client(
        { name: "provider", version: "1" },
        { capabilities: { elicitation: {} } },
      );
      provider.setRequestHandler(ElicitRequestSchema, () => {
        asked += 1;
        return { action: "accept" as const, content: { color: "red" } };
      });
      await provider.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
        }) as Transport,
      );
      clients.push(provider);
      // Thread B has a call waiting while thread A's app asks a question.
      const waiting = provider.callTool({ name: "wait", arguments: { ms: 1_500 } });
      await expect.poll(() => hub.status(projectId)[0]?.state).toBe("ready");
      const app = hub.sessionServer!(ThreadId.makeUnsafe("thread-a"), "fixture")!;
      const answer = await app.appCallTool("ask", {}, new AbortController().signal);
      expect(answer.content).toEqual([{ type: "text", text: "decline:" }]);
      expect(asked).toBe(0);
      expect((await waiting).content).toEqual([{ type: "text", text: "waited" }]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("lets a call finish on a connection an Apply replaced, and reports a raised timeout", async () => {
    const servers = { fixture: { ...stdioServers().fixture!, toolTimeoutSec: 30 } };
    const attachment = attach(servers);
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      const running = client.callTool({ name: "wait", arguments: { ms: 500 } });
      await expect.poll(() => hub.status(projectId)[0]?.state).toBe("ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const update = attachment.update({
        fixture: { ...servers.fixture, toolTimeoutSec: 120 },
      });
      expect(update.changed).toEqual(["fixture"]);
      expect(update.timeoutRaised).toEqual(["fixture"]);
      expect((await running).content).toEqual([{ type: "text", text: "waited" }]);
      // A lower timeout needs nothing from the provider.
      expect(
        attachment.update({ fixture: { ...servers.fixture, toolTimeoutSec: 10 } }).timeoutRaised,
      ).toEqual([]);
    } finally {
      await attachment.dispose();
    }
  });

  it("cuts a withdrawn repository server off from live sessions at once", async () => {
    const attachment = attach(stdioServers(), "repository-thread");
    const threadId = ThreadId.makeUnsafe("repository-thread");
    try {
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      // A withdrawn name whose saved definition the slot is bound to (an applied project
      // override) keeps serving; a settings-only change does not count as different.
      hub.refreshToolPolicies!(projectId, withFixture({ toolPolicy: { echo: "allow" } }), [
        "fixture",
      ]);
      expect(hub.sessionServers!(threadId).size).toBe(1);
      // Without a withdrawn name, a missing server waits for Apply as before.
      hub.refreshToolPolicies!(projectId, {}, []);
      expect(hub.sessionServers!(threadId).size).toBe(1);

      // The saved config has another definition under the name (an unapplied override, or
      // a common server visible once the repository entry is gone): the slot is still on
      // the withdrawn definition, so it is cut off.
      const other = stdioServers("other-report");
      hub.refreshToolPolicies!(projectId, other, ["FIXTURE"]);
      expect(hub.sessionServers!(threadId).size).toBe(0);
      expect(hub.sessionServer!(threadId, "fixture")).toBeUndefined();
      expect((await client.listTools()).tools).toEqual([]);
      const refused = await client.callTool({ name: "echo", arguments: { text: "x" } });
      expect(refused.isError).toBe(true);
      // Approving it again comes back through Apply.
      expect(attachment.update(stdioServers()).changed).toEqual(["fixture"]);
      expect(hub.sessionServers!(threadId).size).toBe(1);
      // A withdrawn name the saved config no longer has is cut off too.
      hub.refreshToolPolicies!(projectId, {}, ["fixture"]);
      expect(hub.sessionServers!(threadId).size).toBe(0);
    } finally {
      await attachment.dispose();
    }
  });

  it("re-binds MCP Apps identity, honours declined servers and refuses closed endpoints", async () => {
    const attachment = attach(stdioServers(), "apps-thread");
    const threadId = ThreadId.makeUnsafe("apps-thread");
    const server = hub.sessionServer!(threadId, "fixture")!;
    try {
      const before = server.binding;
      attachment.update({
        fixture: { ...stdioServers().fixture!, disabledTools: ["hidden", "slow"] },
      });
      expect(server.binding).not.toBe(before);

      // A server the provider refused to install is reached neither way.
      attachment.decline(["fixture"]);
      expect(hub.sessionServer!(threadId, "fixture")).toBeUndefined();
      expect(await server.appListTools()).toEqual([]);
      const endpoint = attachment.endpoints[0]!;
      const client = await connect(endpoint.url, endpoint.token);
      expect((await client.listTools()).tools).toEqual([]);
      expect(attachment.update(stdioServers()).changed).toEqual(["fixture"]);
    } finally {
      await attachment.dispose();
    }
    // A reference kept past dispose cannot restart the server.
    await expect(
      server.appCallTool("echo", { text: "late" }, new AbortController().signal),
    ).rejects.toThrow(/closed/);
    expect(hub.status(projectId)).toEqual([]);
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

  it("reuses a shared connection when only settings-only fields change", async () => {
    const url = "http://127.0.0.1:9/mcp";
    const first = await attach({ remote: { type: "http", url, description: "Docs" } }, "thread-a");
    const second = await attach(
      { remote: { type: "http", url, description: "Team docs", disabledProviders: ["codex"] } },
      "thread-b",
    );
    expect(hub.status(projectId)).toEqual([
      expect.objectContaining({ name: "remote", attachedSessions: 2 }),
    ]);
    await Promise.all([first.dispose(), second.dispose()]);
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

  it("gives OAuth only to remote servers without their own Authorization", async () => {
    await hub.close();
    hub = makeMcpHub({ listener, oauthStorage: memoryOAuthStorage() });
    const withOAuth = hub;
    {
      const url = "http://127.0.0.1:9/mcp";
      const input = {
        threadId: ThreadId.makeUnsafe("thread-oauth"),
        projectId,
        provider: "grok" as const,
        accountKey: "grok",
        environment: { DOCS_TOKEN: "secret" },
        cwd: root,
      };
      const keyed = withOAuth.attach({
        ...input,
        servers: { keyed: { type: "http", url, bearerTokenEnvVar: "DOCS_TOKEN" } },
      });
      expect(await withOAuth.reconnectOAuth(mcpOAuthKey(url, undefined))).toBe(0);
      const open = withOAuth.attach({ ...input, servers: { open: { type: "http", url } } });
      expect(await withOAuth.reconnectOAuth(mcpOAuthKey(url, undefined))).toBe(1);
      await Promise.all([keyed.dispose(), open.dispose()]);
    }
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
