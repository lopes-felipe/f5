import { Effect, Semaphore, ServiceMap } from "effect";

const HeldProviderThreadLocks = ServiceMap.Reference<ReadonlyMap<string, number>>(
  "f5/provider/HeldThreadLocks",
  { defaultValue: () => new Map<string, number>() },
);

const locks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();

/** Serialize provider launches, dispatch, cursor writes and transcript maintenance. */
export function withProviderThreadAccess<A, E, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const held = yield* HeldProviderThreadLocks;
    const fiberId = yield* Effect.fiberId;
    if (held.get(threadId) === fiberId) return yield* effect;
    const next = new Map(held);
    next.set(threadId, fiberId);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(threadId) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        locks.set(threadId, entry);
        return entry;
      }),
      (entry) =>
        entry.gate.withPermit(effect.pipe(Effect.provideService(HeldProviderThreadLocks, next))),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) locks.delete(threadId);
        }),
    );
  });
}
