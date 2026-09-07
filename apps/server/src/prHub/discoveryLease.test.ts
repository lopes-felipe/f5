import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration081 from "../persistence/Migrations/081_PrHubSyncTasks.ts";
import { withPrHubDiscoveryLease, assertPrHubDiscoveryLease } from "./discoveryLease.ts";

const account = { host: "github.com", viewerId: "1" };
const setup = Effect.gen(function* () {
  yield* Migration081;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM pr_hub_sync_tasks`;
  yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
    VALUES ('github', 'github.com', '1', 'search', 'task', '{}', '', '')`;
  return sql;
});
it.layer(SqliteClient.layerMemory())("discovery leases", (it) => {
  it.effect("excludes competing workers and rejects a superseded worker's checkpoint", () =>
    Effect.gen(function* () {
      yield* setup;
      let now = 0;
      let stalePublished = false;
      yield* withPrHubDiscoveryLease(
        account,
        "search",
        "task",
        Effect.gen(function* () {
          assert.isTrue(
            Option.isNone(
              yield* withPrHubDiscoveryLease(account, "search", "task", Effect.void, () => now),
            ),
          );
          now = 120_001;
          yield* withPrHubDiscoveryLease(account, "search", "task", Effect.void, () => now);
          const attempted = yield* assertPrHubDiscoveryLease.pipe(
            Effect.andThen(
              Effect.sync(() => {
                stalePublished = true;
              }),
            ),
            Effect.exit,
          );
          assert.equal(attempted._tag, "Failure");
        }),
        () => now,
      );
      assert.isFalse(stalePublished);
    }),
  );
  it.effect("renews every thirty seconds and releases on interruption", () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      let now = 0;
      const started = yield* Deferred.make<void>();
      const fiber = yield* withPrHubDiscoveryLease(
        account,
        "search",
        "task",
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        () => now,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      now = 30_000;
      yield* TestClock.adjust("30 seconds");
      const rows = yield* sql<{
        lease_expires_at: string;
      }>`SELECT lease_expires_at FROM pr_hub_sync_tasks`;
      assert.equal(rows[0]!.lease_expires_at, new Date(150_000).toISOString());
      yield* Fiber.interrupt(fiber);
      const released = yield* sql<{
        lease_owner: string | null;
      }>`SELECT lease_owner FROM pr_hub_sync_tasks`;
      assert.isNull(released[0]!.lease_owner);
    }),
  );
});
