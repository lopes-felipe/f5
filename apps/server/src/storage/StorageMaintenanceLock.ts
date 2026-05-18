import { Effect, Exit, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

export const MAINTENANCE_LOCK_PERMITS = 1_000_000;

export interface StorageMaintenanceLock {
  readonly withShared: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly acquireExclusive: () => Effect.Effect<Scope.Closeable>;
}

export const makeStorageMaintenanceLock = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(MAINTENANCE_LOCK_PERMITS);

  const acquireExclusive = () =>
    Effect.gen(function* () {
      yield* semaphore.take(MAINTENANCE_LOCK_PERMITS);
      const scope = yield* Scope.make("sequential");
      yield* Scope.addFinalizer(
        scope,
        semaphore.release(MAINTENANCE_LOCK_PERMITS).pipe(Effect.asVoid),
      );
      return scope;
    });

  return {
    withShared: (effect) => semaphore.withPermits(1)(effect),
    acquireExclusive,
  } satisfies StorageMaintenanceLock;
});

export const closeMaintenanceLockScope = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);
