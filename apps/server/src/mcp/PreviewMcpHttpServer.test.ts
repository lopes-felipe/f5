import { assert, it } from "@effect/vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Fiber } from "effect";
import { vi } from "vitest";

import type { InteractionOutcome, InteractionSession } from "./interactionMcpTools.ts";

import { DISABLED_AGENT_BROWSER_POLICY } from "./browserAccess.ts";
import { makePreviewAutomationBroker, PreviewAutomationBroker } from "./PreviewAutomationBroker.ts";
import { makePreviewMcpHttpServer } from "./PreviewMcpHttpServer.ts";
import type { IntegrationProxySession } from "./IntegrationProxyCatalog.ts";

interface McpHttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly sessionId: string | null;
}

function postMcpHttp(
  url: string,
  token: string | null,
  body: unknown,
  method = "POST",
  extraHeaders: Record<string, string> = {},
): Effect.Effect<McpHttpResult, never, never> {
  return Effect.promise(async () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extraHeaders,
    };
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    const init: RequestInit = {
      method,
      headers,
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    return {
      status: response.status,
      body: text.length > 0 ? JSON.parse(text) : null,
      sessionId: response.headers.get("mcp-session-id"),
    };
  });
}

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  };
}

const sessions = new Map<string, string>();

/** The MCP connection for this endpoint and credential, opened on first use. */
function sessionFor(url: string, token: string): Effect.Effect<string, never, never> {
  return Effect.gen(function* () {
    const key = `${url} ${token}`;
    const existing = sessions.get(key);
    if (existing) return existing;
    const init = yield* postMcpHttp(url, token, initializeRequest(0));
    assert.equal(init.status, 200);
    assert.ok(init.sessionId);
    sessions.set(key, init.sessionId);
    return init.sessionId;
  });
}

function postMcp(url: string, token: string, body: unknown): Effect.Effect<unknown, never, never> {
  return Effect.gen(function* () {
    const sessionId = yield* sessionFor(url, token);
    const response = yield* postMcpHttp(url, token, body, "POST", {
      "mcp-session-id": sessionId,
    });
    assert.equal(response.status, 200);
    return response.body;
  });
}

it.effect("negotiates the protocol version up to the SDK's latest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const session = server.createSessionConfig({ threadId: ThreadId.makeUnsafe("t") });
      const token = Object.values(session.env)[0]!;
      const initialize = (protocolVersion: string) =>
        postMcpHttp(server.getUrl(), token, {
          ...initializeRequest(1),
          params: { ...initializeRequest(1).params, protocolVersion },
        });
      for (const version of [LATEST_PROTOCOL_VERSION, "2025-06-18", "2024-11-05"]) {
        const reply = (yield* initialize(version)).body as {
          result: { protocolVersion: string; serverInfo: { name: string } };
        };
        assert.equal(reply.result.protocolVersion, version);
        assert.equal(reply.result.serverInfo.name, "F5 Preview");
      }
      const unknown = (yield* initialize("2099-01-01")).body as {
        result: { protocolVersion: string };
      };
      assert.equal(unknown.result.protocolVersion, LATEST_PROTOCOL_VERSION);
      // Clients that accept only JSON (`t3 mcp-session-stdio`) get JSON replies.
      const jsonOnly = yield* postMcpHttp(server.getUrl(), token, initializeRequest(1), "POST", {
        accept: "application/json",
      });
      assert.equal(jsonOnly.status, 200);
      assert.ok(jsonOnly.sessionId);
      // Requests need the connection's session, like any streamable HTTP server.
      const unsessioned = yield* postMcpHttp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      assert.equal(unsessioned.status, 400);
      session.dispose();
    }),
  ),
);

it.effect("serves preview MCP tools and routes calls through the broker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const threadId = ThreadId.makeUnsafe("thread-preview");
      const session = server.createSessionConfig({ threadId });
      const token = Object.values(session.env)[0]!;

      yield* broker.reportOwner(
        {
          clientId: "client-1",
          threadId,
          tabId: null,
          visible: true,
          supportsAutomation: true,
          focusedAt: "2026-06-23T10:00:00.000Z",
        },
        {
          clientId: "client-1",
          send: (request) =>
            Effect.sync(() => {
              void Effect.runPromise(
                broker.respond(
                  {
                    requestId: request.requestId,
                    clientId: request.clientId,
                    connectionId: request.connectionId,
                    ok: true,
                    result: {
                      available: true,
                      visible: true,
                      tabId: null,
                      url: null,
                      title: null,
                      loading: false,
                    },
                  },
                  new Set(["client-1"]),
                ),
              );
              return true;
            }),
        },
      );

      const listResponse = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })) as {
        result?: {
          tools?: Array<{
            name: string;
            annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
          }>;
        };
      };

      assert.equal(
        listResponse.result?.tools?.some((tool) => tool.name === "preview_status"),
        true,
      );

      const snapshotTool = listResponse.result?.tools?.find(
        (tool) => tool.name === "preview_snapshot",
      );
      assert.equal(snapshotTool?.annotations?.readOnlyHint, false);
      assert.equal(snapshotTool?.annotations?.idempotentHint, false);

      const callResponse = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "preview_status", arguments: {} },
      })) as { result?: { structuredContent?: { available?: boolean } } };

      assert.equal(callResponse.result?.structuredContent?.available, true);

      const restrictedNavigateResponse = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "preview_navigate",
          arguments: { url: "http://169.254.169.254/latest/meta-data" },
        },
      })) as {
        result?: { isError?: boolean; structuredContent?: { error?: { message?: string } } };
      };

      assert.equal(restrictedNavigateResponse.result?.isError, true);
      assert.match(
        restrictedNavigateResponse.result?.structuredContent?.error?.message ?? "",
        /non-loopback host/,
      );

      const restrictedOpenResponse = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "preview_open",
          arguments: { url: "http://example.com" },
        },
      })) as {
        result?: { isError?: boolean; structuredContent?: { error?: { message?: string } } };
      };

      assert.equal(restrictedOpenResponse.result?.isError, true);
      assert.match(
        restrictedOpenResponse.result?.structuredContent?.error?.message ?? "",
        /non-loopback host/,
      );
      session.dispose();
    }),
  ),
);

it.effect("reports no-owner status as unavailable without a tool error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const session = server.createSessionConfig({
        threadId: ThreadId.makeUnsafe("thread-preview"),
      });
      const token = Object.values(session.env)[0]!;

      const response = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "preview_status", arguments: {} },
      })) as {
        result?: { isError?: boolean; structuredContent?: { available?: boolean } };
      };

      assert.notEqual(response.result?.isError, true);
      assert.equal(response.result?.structuredContent?.available, false);
      session.dispose();
    }),
  ),
);

it.effect("sets an explicit tool timeout above the longest broker deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const session = server.createSessionConfig({ threadId: ThreadId.makeUnsafe("t") });
      const definition = session.serverDefinition as { toolTimeoutSec?: number };
      // 60 s executor cap + 2 s broker grace must fit inside the transport timeout.
      assert.equal(definition.toolTimeoutSec, 70);
      assert.ok((definition.toolTimeoutSec ?? 0) * 1000 > 60_000 + 2_000);
      session.dispose();
    }),
  ),
);

it.effect("returns disabled status when live policy turns browser access off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker({
        resolvePolicy: () => Effect.succeed(DISABLED_AGENT_BROWSER_POLICY),
      });
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const session = server.createSessionConfig({ threadId: ThreadId.makeUnsafe("t") });
      const token = Object.values(session.env)[0]!;
      const response = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "preview_status", arguments: {} },
      })) as { result?: { structuredContent?: { reason?: string } } };
      assert.equal(response.result?.structuredContent?.reason, "disabled");
      session.dispose();
    }),
  ),
);

it.effect("preserves typed broker error tags in MCP structured content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const session = server.createSessionConfig({
        threadId: ThreadId.makeUnsafe("thread-preview"),
      });
      const token = Object.values(session.env)[0]!;

      const response = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: {} },
      })) as {
        result?: {
          isError?: boolean;
          structuredContent?: { error?: { _tag?: string; message?: string } };
        };
      };

      assert.equal(response.result?.isError, true);
      assert.equal(
        response.result?.structuredContent?.error?._tag,
        "PreviewAutomationNoFocusedOwnerError",
      );
      session.dispose();
    }),
  ),
);

it.effect("rejects unauthorized and invalid preview MCP HTTP requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const threadId = ThreadId.makeUnsafe("thread-preview");
      const session = server.createSessionConfig({ threadId });
      const token = Object.values(session.env)[0]!;

      const missingToken = yield* postMcpHttp(server.getUrl(), null, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      assert.equal(missingToken.status, 401);

      const wrongPath = yield* postMcpHttp(
        server.getUrl().replace("/mcp/preview", "/mcp/not-preview"),
        token,
        { jsonrpc: "2.0", id: 2, method: "ping" },
      );
      assert.equal(wrongPath.status, 404);

      const wrongMethod = yield* postMcpHttp(
        server.getUrl(),
        token,
        { jsonrpc: "2.0", id: 3, method: "ping" },
        "PUT",
      );
      assert.equal(wrongMethod.status, 405);

      session.dispose();
    }),
  ),
);

it.effect("keeps evaluated values object-shaped and forwards snapshot saving", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const threadId = ThreadId.makeUnsafe("thread-preview-results");
      const session = server.createSessionConfig({ threadId });
      const token = Object.values(session.env)[0]!;
      let value: unknown = null;
      yield* broker.reportOwner(
        {
          clientId: "client-results",
          threadId,
          tabId: "tab-results",
          visible: true,
          supportsAutomation: true,
          focusedAt: new Date().toISOString(),
        },
        {
          clientId: "client-results",
          send: (request) =>
            Effect.sync(() => {
              if (request.operation === "snapshot") assert.deepEqual(request.input, { save: true });
              void Effect.runPromise(
                broker.respond(
                  {
                    requestId: request.requestId,
                    clientId: request.clientId,
                    connectionId: request.connectionId,
                    ok: true,
                    result: value,
                  },
                  new Set(["client-results"]),
                ),
              );
              return true;
            }),
        },
      );
      for (const result of [null, 42, "text", [1, 2], { answer: 42 }]) {
        value = result;
        const response = (yield* postMcp(server.getUrl(), token, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "preview_evaluate", arguments: { expression: "1" } },
        })) as { result: { structuredContent: unknown } };
        assert.deepEqual(
          response.result.structuredContent,
          result !== null && typeof result === "object" && !Array.isArray(result)
            ? result
            : { value: result },
        );
      }
      value = {
        title: "Page",
        screenshot: { mimeType: "image/png", width: 1, height: 1, data: "cG5n" },
        savedScreenshot: { artifactId: "saved-image" },
      };
      const response = (yield* postMcp(server.getUrl(), token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { save: true } },
      })) as { result: { structuredContent: { savedScreenshot: unknown }; content: unknown[] } };
      assert.deepEqual(response.result.structuredContent.savedScreenshot, {
        artifactId: "saved-image",
      });
      assert.equal(response.result.content.length, 2);
    }),
  ),
);

it.effect("routes the integration catalog to its proxy session and revokes it on dispose", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const calls: unknown[] = [];
      const cancelled: string[] = [];
      let disposed = 0;
      const proxy = {
        listTools: async () => [{ name: "js", inputSchema: { type: "object" } }],
        callTool: async (name: string, args: unknown, callId: string, meta: unknown) => {
          calls.push([name, args, callId, meta]);
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
        cancelCall: (callId: string) => cancelled.push(callId),
        dispose: async () => {
          disposed += 1;
        },
      } as unknown as IntegrationProxySession;
      const session = server.createSessionConfig({
        threadId: ThreadId.makeUnsafe("thread-integration"),
        catalog: "integration",
        serverName: "node_repl",
        integration: proxy,
      });
      assert.equal(session.serverName, "node_repl");
      const token = Object.values(session.env)[0]!;
      const url = server.getUrl("integration");
      // Another catalog's endpoint never accepts this credential.
      assert.equal((yield* postMcpHttp(server.getUrl("preview"), token, {})).status, 401);
      const list = (yield* postMcp(url, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as {
        result: { tools: Array<{ name: string }> };
      };
      assert.deepEqual(
        list.result.tools.map((tool) => tool.name),
        ["js"],
      );
      yield* postMcp(url, token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "js",
          arguments: { code: "1" },
          _meta: { "x-codex-turn-metadata": { session_id: "s", turn_id: "t" } },
        },
      });
      assert.equal(calls.length, 1);
      const [name, args, callId, meta] = calls[0] as [string, unknown, string, unknown];
      assert.deepEqual([name, args], ["js", { code: "1" }]);
      // The client's `_meta` reaches the proxy, which decides what to forward.
      assert.deepEqual(meta, { "x-codex-turn-metadata": { session_id: "s", turn_id: "t" } });
      assert.match(callId, /:2$/);
      // A client cancellation reaches the call it names, under the same connection key.
      yield* postMcpHttp(
        url,
        token,
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 2, reason: "user" },
        },
        "POST",
        { "mcp-session-id": yield* sessionFor(url, token) },
      );
      assert.deepEqual(cancelled, [callId]);
      // Each connection has its own id space: after a reconnect, a late cancel from the
      // old connection never names the new connection's call with the same id.
      const first = yield* postMcpHttp(url, token, initializeRequest(1));
      const second = yield* postMcpHttp(url, token, initializeRequest(1));
      assert.ok(first.sessionId && second.sessionId && first.sessionId !== second.sessionId);
      yield* postMcpHttp(
        url,
        token,
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "js", arguments: { code: "2" } },
        },
        "POST",
        { "mcp-session-id": second.sessionId! },
      );
      yield* postMcpHttp(
        url,
        token,
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
        "POST",
        { "mcp-session-id": first.sessionId! },
      );
      const liveCallId = (calls[1] as [string, unknown, string])[2];
      assert.equal(liveCallId, `${second.sessionId}:7`);
      assert.deepEqual(cancelled, [callId, `${first.sessionId}:7`]);
      session.dispose();
      assert.equal(disposed, 1);
      assert.equal(
        (yield* postMcpHttp(url, token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status,
        401,
      );
    }),
  ),
);

it.effect("serves the interaction catalog; a cancelled wait leaves the question open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const outcomes = new Map<
        string,
        { promise: Promise<InteractionOutcome>; resolve: (outcome: InteractionOutcome) => void }
      >();
      const interaction: InteractionSession = {
        openQuestion: async () => {
          const questionId = `q${outcomes.size + 1}`;
          let resolve!: (outcome: InteractionOutcome) => void;
          const promise = new Promise<InteractionOutcome>((done) => (resolve = done));
          outcomes.set(questionId, { promise, resolve });
          if (questionId === "q1") resolve({ answers: { "Which database?": "SQLite" } });
          return { questionId };
        },
        questionOutcome: (questionId) => outcomes.get(questionId)?.promise,
      };
      const session = server.createSessionConfig({
        threadId: ThreadId.makeUnsafe("thread-interaction"),
        catalog: "interaction",
        serverName: "f5_interaction_test",
        interaction,
      });
      assert.equal(session.serverDefinition.toolTimeoutSec, 210);
      const token = Object.values(session.env)[0]!;
      const url = server.getUrl("interaction");
      assert.equal((yield* postMcpHttp(server.getUrl("thread"), token, {})).status, 401);
      const init = yield* postMcpHttp(url, token, initializeRequest(0));
      const instructions = (init.body as { result: { instructions?: string } }).result.instructions;
      assert.include(instructions ?? "", "wait_for_user_answer");
      // Each connection gets its own id space.
      assert.ok(init.sessionId);
      const connection = { "mcp-session-id": init.sessionId! };
      const post = (body: unknown) => postMcpHttp(url, token, body, "POST", connection);
      const list = (yield* post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).body as {
        result: { tools: Array<{ name: string }> };
      };
      assert.deepEqual(
        list.result.tools.map((tool) => tool.name),
        ["ask_user_question", "wait_for_user_answer"],
      );
      const args = {
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "Embedded" },
            ],
          },
        ],
        // Antigravity adds its own summary to every tool call.
        toolSummary: "Ask which database",
      };
      const answered = (yield* post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ask_user_question", arguments: args },
      })).body as { result: { structuredContent: unknown; isError?: boolean } };
      assert.deepEqual(answered.result.structuredContent, {
        answers: { "Which database?": "SQLite" },
      });
      assert.notOk(answered.result.isError);

      const invalid = (yield* post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ask_user_question", arguments: { questions: [] } },
      })).body as { result: { isError?: boolean } };
      assert.equal(invalid.result.isError, true);
      assert.equal(outcomes.size, 1);

      // The client cancelling the call (Antigravity does at three minutes) only ends that wait:
      // the result is pending, and the question stays open.
      let finished = false;
      const waiting = yield* post({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ask_user_question", arguments: args },
      }).pipe(
        Effect.tap(() => Effect.sync(() => (finished = true))),
        Effect.forkChild,
      );
      yield* Effect.promise(() => vi.waitFor(() => assert.equal(outcomes.size, 2)));
      // A cancel from another connection with the same request id reaches nothing.
      const other = yield* postMcpHttp(url, token, initializeRequest(0));
      assert.notEqual(other.sessionId, init.sessionId);
      yield* postMcpHttp(
        url,
        token,
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } },
        "POST",
        { "mcp-session-id": other.sessionId! },
      );
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      assert.equal(finished, false);
      yield* post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } });
      const pending = (yield* Fiber.join(waiting)).body as {
        result: { structuredContent: { pending?: boolean; questionId?: string } };
      };
      assert.deepInclude(pending.result.structuredContent, { pending: true, questionId: "q2" });

      // Waiting again by id returns the answer once the user gives it.
      const again = yield* post({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "wait_for_user_answer", arguments: { questionId: "q2" } },
      }).pipe(Effect.forkChild);
      outcomes.get("q2")!.resolve({ answers: { "Which database?": "Postgres" } });
      const later = (yield* Fiber.join(again)).body as { result: { structuredContent: unknown } };
      assert.deepEqual(later.result.structuredContent, {
        answers: { "Which database?": "Postgres" },
      });
      const unknown = (yield* post({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "wait_for_user_answer", arguments: { questionId: "missing" } },
      })).body as { result: { isError?: boolean } };
      assert.equal(unknown.result.isError, true);

      // Revoking the credential ends a wait still running.
      const revoked = yield* post({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ask_user_question", arguments: args },
      }).pipe(Effect.forkChild);
      yield* Effect.promise(() => vi.waitFor(() => assert.equal(outcomes.size, 3)));
      session.dispose();
      yield* Fiber.join(revoked);
    }),
  ),
);
