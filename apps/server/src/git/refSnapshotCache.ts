import { Cause, Deferred, Effect, Exit, Semaphore } from "effect";

/** Completed entries hold values only; no lookup fibers or caller stack frames survive a scan. */
export function makeRefSnapshotCache<A, E>(
  overloaded: () => E,
  now = () => performance.now(),
  retain: (value: A) => boolean = () => true,
) {
  const values = new Map<string, { value: A; storedAt: number }>();
  const flights = new Map<
    string,
    { done: Deferred.Deferred<Exit.Exit<A, E>>; generation: number }
  >();
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
          if (
            pending.generation !== generation ||
            (Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
          )
            return yield* restore(get(key, lookup, refresh));
          return yield* result;
        }
        if (flights.size >= 64) return yield* Effect.fail(overloaded());
        const done = yield* Deferred.make<Exit.Exit<A, E>>();
        flights.set(key, { done, generation });
        const flight = flights.get(key)!;
        const startedGeneration = generation;
        const exit = yield* Effect.exit(restore(permits.withPermits(1)(lookup)));
        if (flights.get(key)?.done === done) flights.delete(key);
        if (
          Exit.isSuccess(exit) &&
          generation === startedGeneration &&
          flight.generation === generation &&
          retain(exit.value)
        ) {
          values.delete(key);
          values.set(key, { value: exit.value, storedAt: now() });
          if (values.size > 64) values.delete(values.keys().next().value!);
        }
        yield* Deferred.succeed(done, exit);
        return yield* exit;
      }),
    );
  };
  return {
    get,
    invalidate(key?: string) {
      if (key !== undefined) {
        values.delete(key);
        const flight = flights.get(key);
        if (flight) flight.generation = -1;
        return;
      }
      generation++;
      values.clear();
    },
  };
}
