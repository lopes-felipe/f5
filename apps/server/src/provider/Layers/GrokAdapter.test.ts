import { writeAcpWrapper } from "../../testUtils/cli.ts";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Schema, ServiceMap, Stream } from "effect";

import { vi } from "vitest";
import * as GrokAcpSupport from "../acp/GrokAcpSupport.ts";
import { ServerConfig } from "../../config.ts";
import type { GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

class GrokAdapter extends ServiceMap.Service<GrokAdapter, GrokAdapterShape>()(
  "t3/provider/Layers/GrokAdapter.test/GrokAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const GrokAdapterHardeningTestLayer = Layer.effect(
  GrokAdapter,
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-")));
    const wrapperPath = writeAcpWrapper(path.join(dir, "fake-grok"), mockAgentPath, {
      env: { T3_ACP_PROMPT_DELAY_MS: "80", T3_ACP_LOAD_FAIL_NOT_FOUND: "1" },
    });
    const settings = Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath });
    return yield* makeGrokAdapter(settings);
  }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(
      process.cwd(),
      { prefix: "t3code-grok-adapter-hardening-test-" },
      { acpHardeningEnabled: true },
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GrokAdapterHardeningTestLayer)("GrokAdapterLive ACP hardening", (it) => {
  it.effect("ignores a late prompt from an older context with the same resumed session ID", () =>
    Effect.gen(function* () {
      const original = GrokAcpSupport.makeGrokAcpRuntime;
      let release!: () => void;
      let oldSettled = false;
      let calls = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi.spyOn(GrokAcpSupport, "makeGrokAcpRuntime").mockImplementation((input) =>
        original(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            prompt: (promptInput) => {
              const first = calls++ === 0;
              return runtime.prompt(promptInput).pipe(
                Effect.ensuring(
                  first
                    ? Effect.promise(async () => {
                        oldSettled = true;
                        await gate;
                      })
                    : Effect.void,
                ),
              );
            },
          })),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release();
          spy.mockRestore();
        }),
      );
      {
        const adapter = yield* GrokAdapter;
        const threadId = ThreadId.make("same-native-session");
        const session = yield* adapter.startSession({
          threadId,
          provider: "grok",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const old = yield* adapter
          .sendTurn({ threadId, input: "old", attachments: [] })
          .pipe(Effect.forkChild);
        while (!oldSettled)
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
        yield* adapter.interruptTurn(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          provider: "grok",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        assert.deepEqual(resumed.resumeCursor, session.resumeCursor);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const fresh = yield* adapter
          .sendTurn({ threadId, input: "new", attachments: [] })
          .pipe(Effect.forkChild);
        while (calls < 2) yield* Effect.yieldNow;
        release();
        yield* Fiber.join(old);
        yield* Fiber.join(fresh);
        const terminal = yield* Fiber.join(completed).pipe(Effect.timeout("2 seconds"));
        assert.equal(terminal._tag, "Some");
        yield* adapter.stopSession(threadId);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("leaves an idle session alive on repeated Stop", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("idle-stop");
      yield* adapter.startSession({
        threadId,
        provider: "grok",
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.interruptTurn(threadId);
      yield* adapter.interruptTurn(threadId);
      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops the process and active turn even without a prompt cancellation response", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-stop-prompt");
      const events: ProviderRuntimeEvent[] = [];
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const prompt = yield* adapter
        .sendTurn({ threadId, input: "keep working", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(prompt);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      assert.equal(
        events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
        ).length,
        1,
      );
      assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.interrupt(fiber);
    }),
  );
  it.effect("threads resume cursors through the hardened load fallback", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-resume-hardening");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "missing-session" },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps overlapping prompts steered into one active turn", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-overlapping-steering-hardening");
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkScoped);

      const startup = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startup);

      const first = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      const second = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);
      const [firstResult, secondResult] = yield* Effect.all(
        [Fiber.join(first), Fiber.join(second)],
        {
          concurrency: "unbounded",
        },
      );
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));

      assert.equal(firstResult.turnId, secondResult.turnId);
      const turnStarted = events.filter((event) => event.type === "turn.started");
      const turnCompleted = events.filter((event) => event.type === "turn.completed");
      assert.ok(events.some((event) => event.type === "content.delta"));
      assert.equal(turnStarted.length, 1);
      assert.equal(turnCompleted.length, 1);
      assert.equal(turnCompleted[0]?.turnId, firstResult.turnId);

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }),
  );
});
