import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { makePreviewAutomationBroker, PreviewAutomationBroker } from "./PreviewAutomationBroker.ts";
import { makePreviewMcpHttpServer } from "./PreviewMcpHttpServer.ts";
import {
  callThreadTool,
  makeThreadMcpBroker,
  THREAD_READ_RESULT_MAX_BYTES,
  THREAD_TOOL_DEFINITIONS,
  ThreadMcpBroker,
  threadToolDefinitions,
} from "./threadMcpTools.ts";

it("tells agents to leave a rendered page on the thread's own background", () => {
  const description =
    THREAD_TOOL_DEFINITIONS.find((tool) => tool.name === "html_render")?.description ?? "";
  assert.include(description, "leave html, body and the outermost element without a background");
  assert.include(description, "at least 16px of padding");
});

it.effect(
  "binds calls to the transport thread, validates inputs and retires runtime ownership",
  () =>
    Effect.gen(function* () {
      const broker = yield* makeThreadMcpBroker;
      const owner = yield* Scope.make();
      const threadId = ThreadId.makeUnsafe("own-thread");
      const seen: unknown[] = [];
      yield* broker
        .register((id, request) =>
          Effect.sync(() => {
            seen.push([id, request]);
            return { threadId: id };
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, owner));
      const context = { broker, threadId };
      const valid = yield* Effect.promise(() =>
        callThreadTool(context, "thread_status", { threadId: "someone-else" }),
      );
      assert.isUndefined(valid.isError);
      assert.deepStrictEqual(seen, [[threadId, { name: "thread_status" }]]);
      const invalid = yield* Effect.promise(() =>
        callThreadTool(context, "pull_request_review_guide_write", { pr: "x".repeat(2049) }),
      );
      assert.isTrue(invalid.isError);
      assert.lengthOf(seen, 1);
      yield* Scope.close(owner, Exit.void);
      assert.isTrue(
        (yield* Effect.promise(() => callThreadTool(context, "thread_status", {}))).isError,
      );
      assert.lengthOf(seen, 1);
    }),
);

it.effect("never sends raw provider defects through the catalog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeThreadMcpBroker;
      yield* broker.register(() => Effect.die("secret-token"));
      const result = yield* Effect.promise(() =>
        callThreadTool({ broker, threadId: ThreadId.makeUnsafe("t") }, "thread_status", {}),
      );
      assert.isTrue(result.isError);
      assert.isFalse(JSON.stringify(result).includes("secret-token"));
    }),
  ),
);

it.effect(
  "keeps HTTP thread credentials separate from preview credentials and revokes them on disposal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeThreadMcpBroker;
        const seen: string[] = [];
        yield* broker.register((id) =>
          Effect.sync(() => {
            seen.push(id);
            return { threadId: id };
          }),
        );
        const server = yield* makePreviewMcpHttpServer.pipe(
          Effect.provideService(PreviewAutomationBroker, makePreviewAutomationBroker()),
          Effect.provideService(ThreadMcpBroker, broker),
        );
        const threadId = ThreadId.makeUnsafe("thread-tools-http");
        const thread = server.createSessionConfig({ threadId, catalog: "thread" });
        const preview = server.createSessionConfig({ threadId });
        const token = Object.values(thread.env)[0]!;
        const invoke = (url: string, credential: string, method: string) =>
          Effect.promise(async () => {
            const response = await fetch(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: { name: "thread_status", arguments: { threadId: "spoof" } },
              }),
            });
            return {
              status: response.status,
              body: (await response.json()) as { result?: { tools?: Array<{ name: string }> } },
            };
          });
        const url = server.getUrl("thread");
        assert.equal(
          (yield* invoke(url, Object.values(preview.env)[0]!, "tools/list")).status,
          401,
        );
        assert.equal((yield* invoke(server.getUrl(), token, "tools/list")).status, 401);
        const tools = yield* invoke(url, token, "tools/list");
        assert.deepStrictEqual(
          tools.body.result?.tools?.map((tool) => tool.name),
          [
            "thread_read",
            "thread_settle",
            "thread_status",
            "pull_request_review_guide_read",
            "pull_request_review_guide_write",
            "watch_pull_request",
            "unwatch_pull_request",
            "html_render",
            "html_preview",
          ],
        );
        assert.equal((yield* invoke(url, token, "tools/call")).status, 200);
        assert.deepStrictEqual(seen, [threadId]);
        thread.dispose();
        preview.dispose();
        assert.equal((yield* invoke(url, token, "tools/call")).status, 401);
      }),
    ),
);

it("lists only thread_read in the read-only catalog", () => {
  assert.deepStrictEqual(
    threadToolDefinitions("read-only").map((tool) => tool.name),
    ["thread_read"],
  );
  assert.strictEqual(threadToolDefinitions("full"), THREAD_TOOL_DEFINITIONS);
});

it.effect(
  "decodes thread_read, rejects mixed modes and refuses writes under read-only access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeThreadMcpBroker;
        const seen: unknown[] = [];
        yield* broker.register((_id, request) =>
          Effect.sync(() => {
            seen.push(request);
            return { ok: true, echoed: request.name };
          }),
        );
        const context = {
          broker,
          threadId: ThreadId.makeUnsafe("caller"),
          access: "read-only" as const,
        };
        const read = yield* Effect.promise(() =>
          callThreadTool(context, "thread_read", { threadId: "source-1", limit: 5 }),
        );
        assert.isUndefined(read.isError);
        assert.isUndefined(read.structuredContent);
        assert.lengthOf(read.content, 1);
        assert.deepStrictEqual(JSON.parse((read.content[0] as { text: string }).text), {
          ok: true,
          echoed: "thread_read",
        });
        for (const args of [
          { threadId: "source 1" },
          { threadId: "source-1", limit: 51 },
          { threadId: "source-1", item: { kind: "message", id: "m", offset: -1 } },
          { threadId: "source-1", before: "c", item: { kind: "plan", id: "p" } },
          { threadId: "source-1", limit: 2, item: { kind: "plan", id: "p" } },
        ]) {
          assert.isTrue(
            (yield* Effect.promise(() => callThreadTool(context, "thread_read", args))).isError,
          );
        }
        assert.isTrue(
          (yield* Effect.promise(() => callThreadTool(context, "thread_settle", {}))).isError,
        );
        assert.lengthOf(seen, 1);
      }),
    ),
);

it.effect("refuses a thread_read result over the byte cap instead of truncating JSON", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeThreadMcpBroker;
      yield* broker.register(() =>
        Effect.succeed({ ok: true, text: "x".repeat(THREAD_READ_RESULT_MAX_BYTES) }),
      );
      const result = yield* Effect.promise(() =>
        callThreadTool({ broker, threadId: ThreadId.makeUnsafe("t") }, "thread_read", {
          threadId: "s",
        }),
      );
      assert.isTrue(result.isError);
    }),
  ),
);

it.effect("serves a read-only HTTP thread session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeThreadMcpBroker;
      const seen: string[] = [];
      yield* broker.register((_id, request) =>
        Effect.sync(() => {
          seen.push(request.name);
          return { ok: true };
        }),
      );
      const server = yield* makePreviewMcpHttpServer.pipe(
        Effect.provideService(PreviewAutomationBroker, makePreviewAutomationBroker()),
        Effect.provideService(ThreadMcpBroker, broker),
      );
      const session = server.createSessionConfig({
        threadId: ThreadId.makeUnsafe("workflow-stage"),
        catalog: "thread",
        threadAccess: "read-only",
      });
      const token = Object.values(session.env)[0]!;
      const invoke = (method: string, params?: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(server.getUrl("thread"), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          return (await response.json()) as {
            result?: { tools?: Array<{ name: string }>; isError?: boolean };
          };
        });
      assert.deepStrictEqual(
        (yield* invoke("tools/list")).result?.tools?.map((tool) => tool.name),
        ["thread_read"],
      );
      assert.isTrue(
        (yield* invoke("tools/call", { name: "thread_settle", arguments: {} })).result?.isError,
      );
      const read = yield* invoke("tools/call", {
        name: "thread_read",
        arguments: { threadId: "source-1" },
      });
      assert.notEqual(read.result?.isError, true);
      assert.deepStrictEqual(seen, ["thread_read"]);
      session.dispose();
    }),
  ),
);
