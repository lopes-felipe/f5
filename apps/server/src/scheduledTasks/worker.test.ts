import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { retryScheduledOperation } from "./worker.ts";
it.effect(
  "recovers from a transient failure with fake-clock backoff and remains interruptible",
  () =>
    Effect.gen(function* () {
      let attempts = 0;
      const first = yield* Deferred.make<void>();
      const operation = Effect.suspend(() => {
        attempts++;
        if (attempts === 1)
          return Deferred.succeed(first, undefined).pipe(
            Effect.andThen(Effect.fail(new Error("temporary"))),
          );
        return Effect.succeed("recovered");
      });
      const fiber = yield* retryScheduledOperation(operation, "test.worker").pipe(Effect.forkChild);
      yield* Deferred.await(first);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("recovered");
      expect(attempts).toBe(2);
    }),
);
