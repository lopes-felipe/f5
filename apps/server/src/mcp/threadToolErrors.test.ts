import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { makeHtmlRenderRuntime } from "../htmlRender/HtmlRenderRuntime.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { callThreadTool, makeThreadMcpBroker, ThreadToolError } from "./threadMcpTools.ts";
import { makeThreadToolHandler } from "./threadToolRuntime.ts";
import { decideOrchestrationCommand } from "../orchestration/decider.ts";

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
  runtimeMode: RuntimeMode = "full-access",
  turn?: {
    state: "running" | "completed";
    archived?: boolean;
    changed?: boolean;
    events: Array<Omit<OrchestrationEvent, "sequence">>;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "f5-tool-errors-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const model = {
        threads: [
          {
            id: threadId,
            projectId: "project",
            deletedAt: null,
            archivedAt: turn?.archived ? "2026-01-01T00:00:00.000Z" : null,
            runtimeMode,
            messages: [],
            latestTurn: turn ? { turnId: TurnId.makeUnsafe("running"), state: turn.state } : null,
          },
        ],
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
      let delivered: unknown;
      const sendMessage = (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if (turn?.changed) model.threads[0]!.latestTurn!.turnId = TurnId.makeUnsafe("next");
          const result = yield* decideOrchestrationCommand({ command, readModel: model as never });
          for (const event of Array.isArray(result) ? result : [result]) {
            turn?.events.push(event);
            if (event.type === "thread.message-sent") delivered = event.payload;
          }
          return { sequence: 1 };
        });
      yield* broker.register(
        makeThreadToolHandler({
          engine,
          sendMessage,
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
          themes: () => Effect.succeed({ updated: true }),
          messages: {
            getByMessageId: () => Effect.succeed(Option.fromNullishOr(delivered)),
          } as never,
          plans: {} as never,
          sql: {} as never,
        }),
      );
      return yield* use(async (name, input) => {
        const result = await callThreadTool({ broker, threadId }, name, input);
        const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
        return { text, ...(result.isError ? { isError: true } : {}) };
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory()))),
  );

it.effect("sends verbatim Markdown as a completed assistant message on the active turn", () => {
  const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
  const text = "  The draft\n\n**Markdown**\n";
  return withCatalog(
    (call) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => call("send_to_user", { message: text }));
        assert.isUndefined(result.isError);
        assert.lengthOf(events, 1);
        assert.deepInclude(events[0], { type: "thread.message-sent" });
        assert.include(events[0]!.payload, {
          threadId,
          text,
          turnId: TurnId.makeUnsafe("running"),
          role: "assistant",
          streaming: false,
        });
      }),
    "full-access",
    { state: "running", events },
  );
});

it.effect("rejects missing, completed, archived, and replaced turns", () =>
  Effect.gen(function* () {
    for (const scenario of [
      undefined,
      { state: "completed" },
      { state: "running", archived: true },
      { state: "running", changed: true },
    ] as const) {
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      yield* withCatalog(
        (call) =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() => call("send_to_user", { message: "draft" }));
            assert.isTrue(result.isError);
            assert.include(
              result.text,
              scenario && "changed" in scenario
                ? "The active turn changed before sending."
                : "There is no active turn to send from.",
            );
            assert.isEmpty(events);
          }),
        "full-access",
        scenario ? { ...scenario, events } : undefined,
      );
    }
  }),
);

it.effect("permits environment theme writes only in full-access mode", () =>
  Effect.gen(function* () {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      yield* withCatalog(
        (call) =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() => call("theme_set", { appearance: "dark" }));
            if (mode === "full-access") {
              assert.isUndefined(result.isError);
              assert.deepStrictEqual(JSON.parse(result.text), { updated: true });
            } else {
              assert.isTrue(result.isError);
              assert.include(result.text, "requires an active full-access thread");
            }
          }),
        mode,
      );
    }
  }),
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
