import { Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";

/** Replacement and eviction close subscriptions, workers and account caches together. */
export const makeAccountRuntimeCache = <A, E>(
  parentScope: Scope.Scope,
  create: (
    account: { readonly id: string; readonly generation: string },
    scope: Scope.Closeable,
  ) => Effect.Effect<A, E>,
  capacity = 32,
) =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const entries = new Map<
      string,
      { generation: string; pending: Deferred.Deferred<A, E>; value?: A; scope: Scope.Closeable }
    >();
    const reserve = (account: { readonly id: string; readonly generation: string }) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const old = entries.get(account.id);
          if (old?.generation === account.generation) {
            entries.delete(account.id);
            entries.set(account.id, old);
            return old.pending;
          }
          if (old) {
            entries.delete(account.id);
            yield* Scope.close(old.scope, Exit.void);
          }
          if (entries.size >= capacity) {
            const id = entries.keys().next().value!;
            const evicted = entries.get(id)!;
            entries.delete(id);
            yield* Scope.close(evicted.scope, Exit.void);
          }
          const scope = yield* Scope.fork(parentScope);
          const value = yield* Deferred.make<A, E>();
          // Publish the reservation before building, so other accounts can open concurrently.
          const build = yield* create(account, scope).pipe(Effect.forkIn(scope));
          yield* Fiber.await(build).pipe(
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                if (exit._tag === "Failure") {
                  yield* gate.withPermits(1)(
                    Effect.sync(() => {
                      if (entries.get(account.id)?.pending === value) entries.delete(account.id);
                    }),
                  );
                  yield* Scope.close(scope, Exit.void);
                }
                if (exit._tag === "Success") { const entry = entries.get(account.id); if (entry?.pending === value) entry.value = exit.value; }
                yield* Deferred.done(value, exit);
              }),
            ),
            Effect.forkIn(parentScope),
          );
          entries.set(account.id, { generation: account.generation, pending: value, scope });
          return value;
        }),
      );
    const get = (account: { readonly id: string; readonly generation: string }) =>
      reserve(account).pipe(Effect.flatMap(Deferred.await));
    return { entries, get };
  });
