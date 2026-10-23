import { Deferred, Effect, Fiber, Scope } from "effect";

export interface OwnedOperation<EClosed> {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | EClosed, R>;
}

/** Replacement interrupts in-flight work; caller cancellation also interrupts the owned fiber. */
export const makeOwnedOperation = <EClosed>(scope: Scope.Scope, onClosed: () => EClosed) =>
  Effect.gen(function* () {
    let closed = false;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed = true;
      }),
    );
    const owned: OwnedOperation<EClosed> = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.fail(onClosed());
        const done = yield* Deferred.make<A, E>();
        const fiber = yield* effect.pipe(Effect.forkIn(scope));
        // The pinned Effect runtime walks a mutable fiber-observer array. A direct
        // join can remove its observer while a scope's interrupt waiter is notified.
        // A separate Deferred leaves that observer array unchanged during completion.
        fiber.addObserver((exit) => {
          Deferred.doneUnsafe(done, exit);
        });
        return yield* Deferred.await(done).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
      });
    return owned;
  });
