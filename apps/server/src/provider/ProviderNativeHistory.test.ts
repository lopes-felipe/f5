import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { expect, it } from "vitest";
import {
  makeProviderNativeHistory,
  type NativeHistoryReconciliation,
} from "./ProviderNativeHistory.ts";
const request: NativeHistoryReconciliation = {
  requestId: "request",
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("pi"),
  turnId: TurnId.make("turn"),
  removedTurnIds: [],
  isCurrent: Effect.succeed(true),
};
it("requires a live orchestration handler and fences an older handler's scope cleanup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeProviderNativeHistory;
        expect(yield* broker.reconcile(request)).toBe(false);
        const old = yield* Scope.make("sequential");
        yield* broker.install(() => Effect.succeed(false)).pipe(Scope.provide(old));
        yield* broker.install(() => Effect.succeed(true));
        yield* Scope.close(old, Exit.void);
        expect(yield* broker.reconcile(request)).toBe(true);
      }),
    ),
  );
});
it("cancels the owned handler with its caller and releases its admission slot", async () => {
  let interrupted = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeProviderNativeHistory;
        const entered = yield* Deferred.make<void>();
        yield* broker.install(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
        );
        const fiber = yield* broker.reconcile(request).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(interrupted).toBe(1);
        yield* broker.install(() => Effect.succeed(true));
        expect(yield* broker.reconcile(request)).toBe(true);
      }),
    ),
  );
});
it("bounds pending requests and concurrent reconciliation work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeProviderNativeHistory;
        let running = 0;
        const full = yield* Deferred.make<void>();
        yield* broker.install(() =>
          Effect.sync(() => ++running)
            .pipe(
              Effect.flatMap((count) =>
                count === 8 ? Deferred.succeed(full, undefined) : Effect.void,
              ),
            )
            .pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  running--;
                }),
              ),
            ),
        );
        const fibers = yield* Effect.forEach(Array.from({ length: 64 }), () =>
          broker.reconcile(request).pipe(Effect.forkScoped),
        );
        yield* Deferred.await(full);
        yield* Effect.yieldNow;
        expect(running).toBe(8);
        expect(yield* broker.reconcile(request)).toBe(false);
        yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" });
        expect(running).toBe(0);
      }),
    ),
  );
});

effectIt.effect("expires native reconciliation and waits for the owned handler to stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeProviderNativeHistory;
      const entered = yield* Deferred.make<void>();
      let stopped = false;
      yield* broker.install(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        ),
      );
      const done = yield* Deferred.make<boolean>();
      const fiber = yield* broker.reconcile(request).pipe(Effect.forkScoped);
      fiber.addObserver((exit) => {
        Deferred.doneUnsafe(done, exit);
      });
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Deferred.await(done)).toBe(false);
      expect(stopped).toBe(true);
    }),
  ),
);
