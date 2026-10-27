import { Deferred, Effect, Exit, Semaphore } from "effect";

/** Completed entries hold values only; no lookup fibers or caller stack frames survive a scan. */
export function makeRefSnapshotCache<A, E>(
  overloaded: () => E,
  now = () => performance.now(),
  retain: (value: A) => boolean = () => true,
) {
  const values = new Map<string, { value: A; storedAt: number }>();
  const flights = new Map<string, { done: Deferred.Deferred<A, E>; generation: number }>();
  const permits = Semaphore.makeUnsafe(4);
  let generation = 0;
  const get = <R>(
    key: string,
    lookup: Effect.Effect<A, E, R>,
    refresh = false,
  ): Effect.Effect<A, E, R> => {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const entry = values.get(key);
        if (entry && now() - entry.storedAt < (refresh ? 5_000 : 120_000)) return entry.value;
        const pending = flights.get(key);
        if (pending) {
          const result = yield* restore(Deferred.await(pending.done));
          if (pending.generation !== generation) return yield* restore(get(key, lookup, refresh));
          return result;
        }
        if (flights.size >= 64) return yield* Effect.fail(overloaded());
        const done = yield* Deferred.make<A, E>();
        flights.set(key, { done, generation });
        const startedGeneration = generation;
        const exit = yield* Effect.exit(restore(permits.withPermits(1)(lookup)));
        if (flights.get(key)?.done === done) flights.delete(key);
        if (Exit.isSuccess(exit) && generation === startedGeneration && retain(exit.value)) {
          values.delete(key);
          values.set(key, { value: exit.value, storedAt: now() });
          if (values.size > 64) values.delete(values.keys().next().value!);
        }
        yield* Deferred.done(done, exit);
        return yield* exit;
      }),
    );
  };
  return {
    get,
    invalidate() {
      generation++;
      values.clear();
    },
  };
}
