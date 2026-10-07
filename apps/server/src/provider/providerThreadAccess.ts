import { Effect, Semaphore } from "effect";

const locks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();

/** Serialize provider launches, dispatch, cursor writes and transcript maintenance. */
export function withProviderThreadAccess<A, E, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const entry = locks.get(threadId) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
      entry.users++;
      locks.set(threadId, entry);
      return entry;
    }),
    (entry) => entry.gate.withPermit(effect),
    (entry) =>
      Effect.sync(() => {
        if (--entry.users === 0) locks.delete(threadId);
      }),
  );
}
