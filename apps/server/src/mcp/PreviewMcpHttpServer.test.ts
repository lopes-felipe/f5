import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import { makePreviewAutomationBroker, PreviewAutomationBroker } from "./PreviewAutomationBroker.ts";
import { makePreviewMcpHttpServer } from "./PreviewMcpHttpServer.ts";

interface McpHttpResult {
  readonly status: number;
  readonly body: unknown;
}

function postMcpHttp(
  url: string,
  token: string | null,
  body: unknown,
  method = "POST",
): Effect.Effect<McpHttpResult, never, never> {
  return Effect.promise(async () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
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
      })) as { result?: { tools?: Array<{ name: string }> } };

      assert.equal(
        listResponse.result?.tools?.some((tool) => tool.name === "preview_status"),
        true,
      );

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
