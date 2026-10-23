import type { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Scope, Semaphore, ServiceMap } from "effect";

export interface NativeHistoryReconciliation {
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly turnId: TurnId;
  readonly removedTurnIds: readonly TurnId[];
  /** Checks the exact adapter generation and cursor, without acquiring its event gate. */
  readonly isCurrent: Effect.Effect<boolean>;
}
type Handler = (request: NativeHistoryReconciliation) => Effect.Effect<boolean>;
export class ProviderNativeHistory extends ServiceMap.Service<
  ProviderNativeHistory,
  {
    readonly reconcile: Handler;
    readonly install: (handler: Handler) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/provider/ProviderNativeHistory") {}

/** Bounded orchestration rendezvous. An unconfirmed commit leaves the native session blocked. */
export const makeProviderNativeHistory = Effect.gen(function* () {
  let handler: Handler | undefined;
  let pending = 0;
  let closed = false;
  const permits = yield* Semaphore.make(8);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      handler = undefined;
    }),
  );
  return {
    install: (next: Handler) =>
      Effect.gen(function* () {
        handler = next;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (handler === next) handler = undefined;
          }),
        );
      }),
    reconcile: (request: NativeHistoryReconciliation) =>
      Effect.suspend(() => {
        const current = handler;
        if (closed || !current || pending >= 64) return Effect.succeed(false);
        pending++;
        return Effect.scoped(
          Effect.gen(function* () {
            const done = yield* Deferred.make<boolean>();
            const fiber = yield* permits
              .withPermit(
                Effect.suspend(() =>
                  closed || handler !== current ? Effect.succeed(false) : current(request),
                ),
              )
              .pipe(Effect.forkScoped);
            // Do not join a scope-owned fiber directly: completion observers in
            // the pinned Effect runtime must not be removed during notification.
            fiber.addObserver((exit) => {
              Deferred.doneUnsafe(done, exit);
            });
            yield* Effect.sleep("10 seconds").pipe(
              Effect.andThen(Deferred.succeed(done, false)),
              Effect.forkScoped,
            );
            return yield* Deferred.await(done);
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending--;
            }),
          ),
        );
      }),
  };
});
export const ProviderNativeHistoryLive = Layer.effect(
  ProviderNativeHistory,
  makeProviderNativeHistory,
);
