import { Effect, Option, Semaphore, ServiceMap } from "effect";

const HeldProviderThreadLocks = ServiceMap.Reference<ReadonlyMap<string, number>>(
  "f5/provider/HeldThreadLocks",
  { defaultValue: () => new Map<string, number>() },
);

const locks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();

function withThreadGate<A, E, R>(
  threadId: string,
  action: (gate: Semaphore.Semaphore | null) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const held = yield* HeldProviderThreadLocks;
    const fiberId = yield* Effect.fiberId;
    if (held.get(threadId) === fiberId) return yield* action(null);
    const next = new Map(held);
    next.set(threadId, fiberId);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(threadId) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        locks.set(threadId, entry);
        return entry;
      }),
      (entry) => action(entry.gate).pipe(Effect.provideService(HeldProviderThreadLocks, next)),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) locks.delete(threadId);
        }),
    );
  });
}

/** Serialize provider launches, dispatch, cursor writes and transcript maintenance. */
export function withProviderThreadAccess<A, E, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
) {
  return withThreadGate(threadId, (gate) => (gate ? gate.withPermit(effect) : effect));
}

/** Interactive callers can retain exclusion without waiting for a provider launch. */
export function tryWithProviderThreadAccess<A, E, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
) {
  return withThreadGate(threadId, (gate) =>
    gate ? gate.withPermitsIfAvailable(1)(effect) : Effect.map(effect, Option.some),
  );
}
