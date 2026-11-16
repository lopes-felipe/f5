import { Effect, Semaphore } from "effect";

/** A keyed gate whose idle entries are released, including interrupted waiters. */
export function makeOperationGate<Key>() {
  const entries = new Map<Key, { gate: Semaphore.Semaphore; users: number }>();
  return <A, E, R>(threadId: Key, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = entries.get(threadId) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        entries.set(threadId, entry);
        return entry;
      }),
      (entry) => entry.gate.withPermit(effect),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) entries.delete(threadId);
        }),
    );
}
