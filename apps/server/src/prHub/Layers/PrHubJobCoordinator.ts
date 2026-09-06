import { Cause, Deferred, Duration, Effect, Layer, Ref, Stream } from "effect";
import type { PrHubSnapshot } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GitHubRequestPriority } from "../../git/githubRequestScheduler.ts";
import { PrHubJobCoordinator, type PrHubRefresh } from "../Services/PrHubJobCoordinator.ts";

interface Flight {
  deferred: Deferred.Deferred<PrHubSnapshot>;
  mode: "force" | "if_stale";
  trailing: Deferred.Deferred<PrHubSnapshot> | null;
}

export const PrHubJobCoordinatorLive = Layer.effect(
  PrHubJobCoordinator,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const settings = yield* ServerSettingsService;
    let monitoringStarted = false;
    return {
      createRefresh: (run: PrHubRefresh) =>
        Effect.gen(function* () {
          const active = yield* Ref.make<Flight | null>(null);
          const worker = (initial: Flight) =>
            Effect.gen(function* () {
              let flight = initial;
              while (true) {
                const result = yield* Effect.exit(run({ mode: flight.mode }));
                const next = yield* Ref.modify(
                  active,
                  (current): readonly [Flight | null, Flight | null] => {
                    if (current?.deferred !== flight.deferred) return [null, current];
                    if (!current.trailing) return [null, null];
                    const promoted: Flight = {
                      deferred: current.trailing,
                      mode: "force",
                      trailing: null,
                    };
                    return [promoted, promoted];
                  },
                );
                yield* Deferred.done(flight.deferred, result);
                if (!next) return;
                flight = next;
              }
            });
          // The worker belongs to the service, not the first WebSocket caller's lifetime.
          return (input: Parameters<PrHubRefresh>[0]) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const deferred = yield* Deferred.make<PrHubSnapshot>();
                const acquired = yield* Ref.modify(
                  active,
                  (
                    current,
                  ): readonly [
                    { started: Flight | null; result: Deferred.Deferred<PrHubSnapshot> },
                    Flight | null,
                  ] => {
                    if (!current) {
                      const flight: Flight = { deferred, mode: input.mode, trailing: null };
                      return [{ started: flight, result: deferred }, flight];
                    }
                    if (input.mode === "force" && current.mode === "if_stale") {
                      const trailing = current.trailing ?? deferred;
                      return [
                        { started: null, result: trailing },
                        { ...current, trailing },
                      ];
                    }
                    return [{ started: null, result: current.deferred }, current];
                  },
                );
                if (acquired.started)
                  yield* worker(acquired.started).pipe(Effect.interruptible, Effect.forkIn(scope));
                return yield* restore(Deferred.await(acquired.result));
              }),
            );
        }),
      startMonitoring: (refresh: PrHubRefresh) =>
        Effect.gen(function* () {
          if (monitoringStarted) return;
          monitoringStarted = true;
          yield* Effect.sleep(Duration.seconds(5)).pipe(
            Effect.andThen(
              Effect.forever(
                Effect.gen(function* () {
                  const current = yield* settings.getSettings;
                  const interval = current.prHub.pollIntervalSeconds;
                  if (interval === 0) {
                    // Periodic recheck also closes a settings-event subscription race on re-enabling.
                    yield* Effect.raceFirst(
                      settings.streamChanges.pipe(
                        Stream.filter((next) => next.prHub.pollIntervalSeconds !== 0),
                        Stream.runHead,
                      ),
                      Effect.sleep(Duration.seconds(30)),
                    );
                    return;
                  }
                  yield* refresh({ mode: "if_stale" }).pipe(
                    Effect.provideService(GitHubRequestPriority, "background"),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("PR Hub refresh failed", {
                        causePretty: Cause.pretty(cause),
                      }),
                    ),
                  );
                  yield* Effect.sleep(Duration.seconds(interval));
                }),
              ),
            ),
            Effect.forkIn(scope),
          );
        }),
    };
  }),
);
