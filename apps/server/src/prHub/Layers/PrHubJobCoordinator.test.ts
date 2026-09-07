import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { PrHubSnapshot } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PrHubJobCoordinator } from "../Services/PrHubJobCoordinator.ts";
import { PrHubJobCoordinatorLive } from "./PrHubJobCoordinator.ts";

const snapshot: PrHubSnapshot = {
  status: "ok",
  host: "github.com",
  viewerLogin: "me",
  pullRequests: [],
  recentlyResolved: [],
  lastPolledAt: null,
};
const layer = PrHubJobCoordinatorLive.pipe(
  Layer.provide(SqliteClient.layerMemory()),
  Layer.provideMerge(ServerSettingsService.layerTest({ prHub: { pollIntervalSeconds: 0 } })),
);

it.layer(layer)("PR background coordination", (it) => {
  it.effect(
    "finishes shared work after caller cancellation and coalesces trailing force refreshes",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* PrHubJobCoordinator;
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const calls: string[] = [];
        const refresh = yield* coordinator.createRefresh((input) =>
          Effect.gen(function* () {
            calls.push(input.mode);
            if (calls.length === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
            }
            return snapshot;
          }),
        );
        const first = yield* refresh({ mode: "if_stale" }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        const second = yield* refresh({ mode: "force" }).pipe(Effect.forkScoped);
        const third = yield* refresh({ mode: "force" }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        assert.deepStrictEqual(yield* Fiber.join(second), snapshot);
        assert.deepStrictEqual(yield* Fiber.join(third), snapshot);
        assert.deepStrictEqual(calls, ["if_stale", "force"]);
      }),
  );
  it.effect("does not leave the queue stuck after a worker defect", () =>
    Effect.gen(function* () {
      const coordinator = yield* PrHubJobCoordinator;
      let calls = 0;
      const refresh = yield* coordinator.createRefresh(() =>
        Effect.suspend(() =>
          ++calls === 1 ? Effect.die("failed worker") : Effect.succeed(snapshot),
        ),
      );
      assert.equal((yield* Effect.exit(refresh({ mode: "force" })))._tag, "Failure");
      assert.deepStrictEqual(yield* refresh({ mode: "force" }), snapshot);
    }),
  );
  it.effect("wakes a degraded refresh at its recovery deadline instead of the normal poll", () =>
    Effect.gen(function* () {
      const coordinator = yield* PrHubJobCoordinator;
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ prHub: { pollIntervalSeconds: 300 } });
      let calls = 0;
      const refresh = () =>
        Effect.sync(() => {
          calls++;
          const now = Date.now();
          return {
            ...snapshot,
            status: calls === 1 ? ("degraded" as const) : ("ok" as const),
            lastPolledAt: new Date(now).toISOString(),
            nextRefreshAt: new Date(now + 30_000).toISOString(),
          };
        });
      yield* coordinator.startMonitoring(refresh);
      yield* TestClock.adjust("5 seconds");
      assert.equal(calls, 1);
      yield* TestClock.adjust("29 seconds");
      assert.equal(calls, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(calls, 2);
      yield* settings.updateSettings({ prHub: { pollIntervalSeconds: 0 } });
      yield* TestClock.adjust("10 minutes");
      assert.equal(calls, 2);
    }).pipe(Effect.provide(Layer.fresh(layer))),
  );
  it.effect("monitors without a dashboard, starts once and honors disabled polling", () =>
    Effect.gen(function* () {
      const coordinator = yield* PrHubJobCoordinator;
      const settings = yield* ServerSettingsService;
      let calls = 0;
      const refresh = () =>
        Effect.sync(() => {
          calls++;
          return snapshot;
        });
      yield* coordinator.startMonitoring(refresh);
      yield* coordinator.startMonitoring(refresh);
      yield* TestClock.adjust("5 seconds");
      assert.equal(calls, 0);
      yield* settings.updateSettings({ prHub: { pollIntervalSeconds: 60 } });
      yield* TestClock.adjust("1 second");
      assert.equal(calls, 1);
      yield* settings.updateSettings({ prHub: { pollIntervalSeconds: 0 } });
      yield* TestClock.adjust("2 minutes");
      assert.equal(calls, 1);
    }),
  );
});
