import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

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

function postMcp(url: string, token: string, body: unknown): Effect.Effect<unknown, never, never> {
  return Effect.gen(function* () {
    const response = yield* postMcpHttp(url, token, body);
    assert.equal(response.status, 200);
    return response.body;
  });
}

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
        callTool: async (name: string, args: unknown, callId: string) => {
          calls.push([name, args, callId]);
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
        params: { name: "js", arguments: { code: "1" } },
      });
      assert.equal(calls.length, 1);
      const [name, args, callId] = calls[0] as [string, unknown, string];
      assert.deepEqual([name, args], ["js", { code: "1" }]);
      assert.match(callId, /:2$/);
      // A client cancellation reaches the call it names, under the same connection key.
      yield* postMcpHttp(url, token, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 2, reason: "user" },
      });
      assert.deepEqual(cancelled, [callId]);
      // Each connection has its own id space: after a reconnect, a late cancel from the
      // old connection never names the new connection's call with the same id.
      const first = yield* postMcpHttp(url, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
      const second = yield* postMcpHttp(url, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
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
