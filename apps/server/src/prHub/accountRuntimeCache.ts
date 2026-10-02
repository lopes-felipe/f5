import { Effect, Exit, Scope, Semaphore } from "effect";

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
    const entries = new Map<string, { generation: string; value: A; scope: Scope.Closeable }>();
    const get = (account: { readonly id: string; readonly generation: string }) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const old = entries.get(account.id);
          if (old?.generation === account.generation) {
            entries.delete(account.id);
            entries.set(account.id, old);
            return old.value;
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
          const value = yield* create(account, scope).pipe(
            Effect.onExit((exit) =>
              exit._tag === "Failure" ? Scope.close(scope, Exit.void) : Effect.void,
            ),
          );
          entries.set(account.id, { generation: account.generation, value, scope });
          return value;
        }),
      );
    return { entries, get };
  });
