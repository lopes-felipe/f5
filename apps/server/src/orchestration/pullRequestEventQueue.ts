import { Effect, Queue } from "effect";

/** Coalesce queued hints, but allow one follow-up hint while the preceding read runs. */
export const makePullRequestEventQueue = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<string>();
  const pending = new Set<string>();
  return {
    offer(key: string) {
      if (pending.has(key)) return;
      pending.add(key);
      Queue.offerUnsafe(queue, key);
    },
    take: Queue.take(queue).pipe(Effect.tap((key) => Effect.sync(() => pending.delete(key)))),
    shutdown: Queue.shutdown(queue),
  };
});
