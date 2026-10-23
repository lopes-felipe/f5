import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { makePreviewAutomationBroker, PreviewAutomationBroker } from "./PreviewAutomationBroker.ts";
import { makePreviewMcpHttpServer } from "./PreviewMcpHttpServer.ts";
import {
  callThreadTool,
  makeThreadMcpBroker,
  THREAD_TOOL_DEFINITIONS,
  ThreadMcpBroker,
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
