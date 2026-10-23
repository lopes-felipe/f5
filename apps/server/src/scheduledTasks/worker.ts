import { Cause, Duration, Effect } from "effect";

/** One bad database/provider operation must not terminate a long-lived worker. */
export const retryScheduledOperation = <A, E, R>(operation: Effect.Effect<A, E, R>, name: string) =>
  Effect.gen(function* () {
    let attempts = 0;
    for (;;) {
      const exit = yield* Effect.exit(operation);
      if (exit._tag === "Success") return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
      yield* Effect.logError(name, { cause: Cause.pretty(exit.cause), attempt: ++attempts });
      yield* Effect.sleep(Duration.millis(Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5))));
    }
  });
