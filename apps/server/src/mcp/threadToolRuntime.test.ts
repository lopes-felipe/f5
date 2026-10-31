import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeHtmlRenderRuntime } from "../htmlRender/HtmlRenderRuntime.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { callThreadTool, makeThreadMcpBroker, ThreadToolError } from "./threadMcpTools.ts";
import { makeThreadToolHandler } from "./threadToolRuntime.ts";

const threadId = ThreadId.makeUnsafe("runtime-thread");
const SECRET = "secret-token-from-a-caught-exception";
const GENERIC = [
  "Thread tool could not complete. Check the input and current thread, then retry.",
  "Thread tool failed or timed out. Retry after refreshing the thread.",
  "Thread tool failed. Check the PR target, account and current thread, then retry.",
];

const withCatalog = <A, E>(
  use: (
    call: (name: string, input: unknown) => Promise<{ text: string; isError?: boolean }>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "f5-tool-errors-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const model = {
        threads: [{ id: threadId, projectId: "project", deletedAt: null, archivedAt: null }],
        projects: [{ id: "project", deletedAt: null, kind: "standard", workspaceRoot: root }],
      };
      const engine = {
        getReadModel: () => Effect.succeed(model as never),
        dispatch: () => Effect.die("unused"),
      };
      const html = yield* makeHtmlRenderRuntime({
        engine,
        attachmentsDir: path.join(root, "attachments"),
        preview: { render: () => Effect.die("unused") } as never,
      });
      const broker = yield* makeThreadMcpBroker;
      yield* broker.register(
        makeThreadToolHandler({
          engine,
          html,
          federation: {
            parseUrl: () => Effect.die(SECRET),
            resolve: () => Effect.die(SECRET),
          } as never,
          settlement: { settleFromAgent: () => Effect.fail(new Error(SECRET)) } as never,
          watches: {
            startWatch: () => Effect.fail({ _tag: "GitHubError", message: SECRET }),
            stopWatch: () => Effect.die(new Error(SECRET)),
          } as never,
          guides: {} as never,
          links: { getThreadLinks: () => Effect.succeed([]) } as never,
        }),
      );
      return yield* use(async (name, input) => {
        const result = await callThreadTool({ broker, threadId }, name, input);
        const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
        return { text, ...(result.isError ? { isError: true } : {}) };
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory()))),
  );

it.effect("returns a rejected page's message to the agent word for word", () =>
  withCatalog((call) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        call("html_render", {
          html: '<div style="min-height:100vh">Chart</div>',
          title: "Chart",
          height: 300,
        }),
      );
      assert.deepStrictEqual(result, {
        text: "The page uses a viewport height unit (100vh). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.",
        isError: true,
      });
      const empty = yield* Effect.promise(() => call("html_preview", { html: "" }));
      assert.deepStrictEqual(empty, {
        text: "Unknown thread tool or invalid input.",
        isError: true,
      });
    }),
  ),
);

it.effect("keeps caught exceptions and defects from PR, watch and settle tools generic", () =>
  withCatalog((call) =>
    Effect.gen(function* () {
      for (const [name, input] of [
        ["thread_settle", {}],
        ["watch_pull_request", { pr: "https://github.com/org/repo/pull/1" }],
        ["unwatch_pull_request", {}],
        ["pull_request_review_guide_read", { pr: "https://github.com/org/repo/pull/1" }],
      ] as const) {
        const result = yield* Effect.promise(() => call(name, input));
        assert.isTrue(result.isError, name);
        assert.notInclude(result.text, SECRET, name);
        assert.include(GENERIC, result.text, name);
      }
      // An authored message about the request itself still reaches the agent.
      const target = yield* Effect.promise(() => call("pull_request_review_guide_read", {}));
      assert.deepStrictEqual(target, {
        text: "Specify a PR URL or key, or link exactly one PR to this thread.",
        isError: true,
      });
    }),
  ),
);

it.effect("maps a timed-out tool to the generic timeout message", () =>
  Effect.gen(function* () {
    const broker = yield* makeThreadMcpBroker;
    yield* broker.register(() => Effect.never);
    const fiber = yield* broker
      .call(threadId, { name: "thread_status" })
      .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("31 seconds");
    const error = yield* Fiber.join(fiber);
    assert.instanceOf(error, ThreadToolError);
    assert.equal(
      error.message,
      "Thread tool failed or timed out. Retry after refreshing the thread.",
    );
  }).pipe(Effect.scoped),
);
