import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0116 from "../Migrations/116_UsageAccountHistory.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import { UsageAccountHistoryRepository } from "../Services/UsageAccountHistory.ts";
import { UsageAccountHistoryRepositoryLive } from "./UsageAccountHistory.ts";

const sample = (sampledAt: string, usedPercent: number) => ({
  windowKey: "five_hour",
  sampledAt,
  usedPercent,
  resetsAt: "2026-10-15T15:00:00.000Z",
});

it.layer(SqliteClient.layerMemory())("116_UsageAccountHistory", (it) => {
  it.effect("creates the tables and index idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0116;
      yield* Migration0116;
      const objects = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN ('usage_account_snapshots', 'usage_quota_samples', 'usage_quota_samples_sampled_idx')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        objects.map((entry) => entry.name),
        ["usage_account_snapshots", "usage_quota_samples", "usage_quota_samples_sampled_idx"],
      );
    }),
  );
});

it.layer(SqliteClient.layerMemory())("UsageAccountHistoryRepository", (it) => {
  it.effect("keeps the newest snapshot, resets on identity change, and prunes", () =>
    Effect.gen(function* () {
      yield* Migration0116;
      const repository = yield* UsageAccountHistoryRepository;
      yield* repository.recordObservation({
        accountKey: "claude:a",
        identity: "one",
        snapshots: [
          { sectionKind: "claude-usage", fetchedAt: "2026-10-15T10:00:00.000Z", dataJson: '"new"' },
        ],
        samples: [sample("2026-10-15T10:00:00.000Z", 10)],
      });
      // Older snapshot is ignored; the duplicate sample is ignored.
      yield* repository.recordObservation({
        accountKey: "claude:a",
        identity: "one",
        snapshots: [
          { sectionKind: "claude-usage", fetchedAt: "2026-10-15T09:00:00.000Z", dataJson: '"old"' },
        ],
        samples: [sample("2026-10-15T10:00:00.000Z", 99), sample("2026-09-01T00:00:00.000Z", 1)],
      });
      assert.deepStrictEqual(
        (yield* repository.listSnapshots).map((row) => row.dataJson),
        ['"new"'],
      );
      assert.deepStrictEqual(
        (yield* repository.listSamplesSince("2026-01-01T00:00:00.000Z")).map(
          (row) => row.usedPercent,
        ),
        [1, 10],
      );

      // A new identity replaces rows recorded under the old one.
      yield* repository.recordObservation({
        accountKey: "claude:a",
        identity: "two",
        snapshots: [
          {
            sectionKind: "claude-usage",
            fetchedAt: "2026-10-15T08:00:00.000Z",
            dataJson: '"other-account"',
          },
        ],
        samples: [sample("2026-10-15T08:00:00.000Z", 2)],
      });
      const snapshots = yield* repository.listSnapshots;
      assert.deepStrictEqual(
        snapshots.map((row) => [row.identity, row.dataJson]),
        [["two", '"other-account"']],
      );
      assert.deepStrictEqual(
        (yield* repository.listSamplesSince("2026-01-01T00:00:00.000Z")).map((row) => row.identity),
        ["two"],
      );

      yield* repository.recordObservation({
        accountKey: "codex:b",
        identity: "b",
        snapshots: [
          { sectionKind: "codex-limits", fetchedAt: "2026-10-15T08:00:00.000Z", dataJson: "{}" },
        ],
        samples: [sample("2026-08-01T00:00:00.000Z", 3), sample("2026-10-15T08:00:00.000Z", 4)],
      });
      yield* repository.recordObservation({
        accountKey: "cursor:removed",
        identity: "r",
        snapshots: [
          { sectionKind: "provider-limits", fetchedAt: "2026-08-01T00:00:00.000Z", dataJson: "{}" },
        ],
        samples: [sample("2026-08-01T00:00:00.000Z", 5)],
      });
      // "claude:a" is missing from the keep-list (e.g. mid registry reconcile)
      // but its recent history survives; only old rows expire.
      yield* repository.prune({
        before: "2026-09-10T00:00:00.000Z",
        keepAccountKeys: ["codex:b"],
      });
      assert.deepStrictEqual(
        (yield* repository.listSnapshots).map((row) => row.accountKey).toSorted(),
        ["claude:a", "codex:b"],
      );
      assert.deepStrictEqual(
        (yield* repository.listSamplesSince("2026-01-01T00:00:00.000Z"))
          .map((row) => [row.accountKey, row.usedPercent])
          .toSorted(),
        [
          ["claude:a", 2],
          ["codex:b", 4],
        ],
      );
      // An empty keep-list never deletes snapshots.
      yield* repository.prune({ before: "2026-12-01T00:00:00.000Z", keepAccountKeys: [] });
      assert.equal((yield* repository.listSnapshots).length, 2);
      yield* repository.deleteSnapshot("codex:b", "codex-limits");
      assert.equal((yield* repository.listSnapshots).length, 1);
    }).pipe(Effect.provide(UsageAccountHistoryRepositoryLive)),
  );

  it.effect("rolls back the whole observation when a write fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0116;
      yield* sql`DELETE FROM usage_account_snapshots`;
      yield* sql`DELETE FROM usage_quota_samples`;
      yield* sql`
        CREATE TEMP TRIGGER fail_samples BEFORE INSERT ON usage_quota_samples
        BEGIN SELECT RAISE(ABORT, 'sample write failed'); END
      `;
      const repository = yield* UsageAccountHistoryRepository;
      const exit = yield* Effect.exit(
        repository.recordObservation({
          accountKey: "claude:a",
          identity: "one",
          snapshots: [
            { sectionKind: "claude-usage", fetchedAt: "2026-10-15T10:00:00.000Z", dataJson: "{}" },
          ],
          samples: [sample("2026-10-15T10:00:00.000Z", 1)],
        }),
      );
      yield* sql`DROP TRIGGER fail_samples`;
      assert.isTrue(Exit.isFailure(exit));
      assert.equal((yield* repository.listSnapshots).length, 0);
    }).pipe(Effect.provide(UsageAccountHistoryRepositoryLive)),
  );
});
