import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Clock, Deferred, Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeScheduledTaskService } from "./Service.ts";
import { setup, testLayer } from "./testing.ts";

it.effect(
  "the engine coalesces a forward wall-clock jump and never reopens consumed fires after rollback",
  () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      let wall = 0;
      let monotonic = 0;
      const simulatedWallClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => wall,
        currentTimeMillis: Effect.sync(() => wall),
        currentTimeNanosUnsafe: () => BigInt(wall) * 1000000n,
        currentTimeNanos: Effect.sync(() => BigInt(wall) * 1000000n),
        sleep: (duration) => clock.sleep(duration),
      };
      yield* Effect.gen(function* () {
        const { create, store, host, settings } = yield* setup;
        const { task } = yield* create();
        let watchdogFinished = yield* Deferred.make<void>();
        const submitted = yield* Deferred.make<void>();
        const runtime = yield* makeScheduledTaskService({
          store: {
            ...store,
            prune: (at) =>
              store.prune(at).pipe(Effect.tap(() => Deferred.succeed(watchdogFinished, undefined))),
          },
          host: {
            ...host.shape,
            submitTurnSubmission: (body, options) =>
              host.shape
                .submitTurnSubmission(body, options)
                .pipe(Effect.tap(() => Deferred.succeed(submitted, undefined))),
          },
          settings,
          monotonic: () => monotonic,
          publish: () => Effect.void,
        });
        yield* runtime.start;
        // Only the test clock advances sleeps. Wall and monotonic time are
        // independent, modeling a suspended machine without real timers.
        wall = 300000;
        monotonic = 60000;
        yield* TestClock.adjust("1 minute").pipe(Effect.provideService(Clock.Clock, clock));
        yield* Deferred.await(watchdogFinished);
        yield* Deferred.await(submitted);
        yield* runtime.drainDispatches;
        const history = yield* store.history(task.id);
        expect(history).toHaveLength(1);
        expect(history[0]!.run.trigger).toBe("catch_up");
        expect(history[0]!.run.scheduledFor).toBe("1970-01-01T00:01:00.000Z");
        expect((yield* store.task(task.id))!.task.nextRunAt).toBe("1970-01-01T00:06:00.000Z");
        watchdogFinished = yield* Deferred.make<void>();
        wall = 120000;
        monotonic = 120000;
        yield* TestClock.adjust("1 minute").pipe(Effect.provideService(Clock.Clock, clock));
        yield* Deferred.await(watchdogFinished);
        expect(yield* store.history(task.id)).toHaveLength(1);
        expect((yield* store.task(task.id))!.task.nextRunAt).toBe("1970-01-01T00:06:00.000Z");
        expect(host.submissions).toHaveLength(1);
      }).pipe(Effect.provideService(Clock.Clock, simulatedWallClock));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
