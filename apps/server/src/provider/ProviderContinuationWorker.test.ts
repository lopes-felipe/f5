import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type NextTurnQueueItem,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";
import { expect, it } from "vitest";
import { processProviderContinuation } from "./ProviderContinuationWorker.ts";
import type { ProviderContinuationRequest } from "./ProviderContinuationRequests.ts";
const own: NextTurnQueueItem = {
  itemId: CommandId.make("wake"),
  submissionId: CommandId.make("wake"),
  threadId: ThreadId.make("thread"),
  position: 0,
  status: "queued",
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make("wake"),
    threadId: ThreadId.make("thread"),
    message: {
      messageId: MessageId.make("wake"),
      role: "user",
      text: "Native continuation",
      attachments: [],
    },
    continuationRequestId: "wake",
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: "2026-10-19T00:00:00.000Z",
  },
  attemptCount: 0,
  notBefore: null,
  scheduleReason: null,
  dispatchStartedAt: null,
  lastErrorCode: null,
  lastErrorDetail: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};
const fixture = () => {
  let now = 100,
    status: "pending" | "adopted" | "closed" = "pending";
  const calls = { enqueue: 0, notify: 0, clear: 0, discard: 0 };
  const request: ProviderContinuationRequest = {
    requestId: "wake",
    threadId: own.threadId,
    providerInstanceId: ProviderInstanceId.make("pi"),
    generation: "generation",
    createdAt: 100,
    previousTurnId: TurnId.make("previous"),
    runtimeMode: "approval-required",
    model: "default",
    status: Effect.sync(() => status),
    dispatchIfCurrent: (effect) => effect.pipe(Effect.map(Option.some)),
    clearIfCurrent: Effect.sync(() => {
      calls.clear++;
    }),
  };
  const deps: Parameters<typeof processProviderContinuation>[1] = {
    enqueue: () =>
      Effect.sync(() => {
        calls.enqueue++;
        return "queued";
      }),
    snapshot: () => Effect.succeed({ paused: false, blockedKind: null, items: [own] }),
    notify: () =>
      Effect.sync(() => {
        calls.notify++;
      }),
    discardQueued: () =>
      Effect.sync(() => {
        calls.discard++;
      }),
    now: () => now,
    delay: Effect.sync(() => {
      now += 1000;
    }),
  };
  return {
    request,
    deps,
    calls,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
};
it("admits an exact buffered wake and observes its adoption without sending another prompt", async () => {
  const f = fixture();
  const deps = { ...f.deps, delay: Effect.sync(() => f.setStatus("adopted")) };
  expect(await Effect.runPromise(processProviderContinuation(f.request, deps))).toBe(true);
  expect(f.calls).toEqual({ enqueue: 1, notify: 1, clear: 0, discard: 0 });
});
it.each(["paused", "failed", "closed", "expired", "stale", "busy", "edited", "removed"])(
  "retires native work when continuation admission is %s",
  async (mode) => {
    const f = fixture();
    const deps = {
      ...f.deps,
      ...(mode === "paused"
        ? {
            snapshot: () =>
              Effect.succeed({ paused: true, blockedKind: "paused" as const, items: [own] }),
          }
        : {}),
      ...(mode === "failed"
        ? {
            snapshot: () =>
              Effect.succeed({
                paused: false,
                blockedKind: "error" as const,
                items: [{ ...own, status: "failed" as const }],
              }),
          }
        : {}),
      ...(mode === "busy" ? { enqueue: () => Effect.succeed("rejected" as const) } : {}),
      ...(mode === "removed"
        ? { snapshot: () => Effect.succeed({ paused: false, blockedKind: null, items: [] }) }
        : {}),
      ...(mode === "edited"
        ? {
            snapshot: () =>
              Effect.succeed({
                paused: false,
                blockedKind: null,
                items: [{ ...own, command: { ...own.command, continuationRequestId: "edited" } }],
              }),
          }
        : {}),
    };
    const request: ProviderContinuationRequest =
      mode === "stale"
        ? { ...f.request, dispatchIfCurrent: () => Effect.succeed(Option.none()) }
        : f.request;
    if (mode === "closed") f.setStatus("closed");
    expect(await Effect.runPromise(processProviderContinuation(request, deps))).toBe(false);
    expect(f.calls.clear).toBe(1);
    expect(f.calls.discard).toBe(1);
  },
);
it("keeps cancellation interruptible while still releasing native ownership", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const fiber = yield* processProviderContinuation(f.request, {
          ...f.deps,
          delay: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
  expect(f.calls.clear).toBe(1);
  expect(f.calls.discard).toBe(1);
});

it("waits for delayed F5 settlement projection while retaining the exact native owner", async () => {
  const f = fixture();
  let checks = 0;
  const deps = {
    ...f.deps,
    enqueue: () => Effect.sync(() => (++checks < 3 ? ("wait" as const) : ("queued" as const))),
    notify: () => Effect.sync(() => f.setStatus("adopted")),
  };
  expect(await Effect.runPromise(processProviderContinuation(f.request, deps))).toBe(true);
  expect(checks).toBe(3);
  expect(f.calls.clear).toBe(0);
});
