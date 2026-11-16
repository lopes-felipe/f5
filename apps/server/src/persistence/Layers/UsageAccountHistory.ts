import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  UsageAccountHistoryRepository,
  type PersistedAccountSnapshot,
  type QuotaSampleRow,
  type UsageAccountHistoryRepositoryShape,
} from "../Services/UsageAccountHistory.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listSnapshots: UsageAccountHistoryRepositoryShape["listSnapshots"] =
    sql<PersistedAccountSnapshot>`
      SELECT
        account_key AS "accountKey",
        section_kind AS "sectionKind",
        account_identity AS "identity",
        fetched_at AS "fetchedAt",
        data_json AS "dataJson"
      FROM usage_account_snapshots
      ORDER BY account_key, section_kind
    `.pipe(Effect.mapError(toPersistenceSqlError("UsageAccountHistoryRepository.listSnapshots")));

  const recordObservation: UsageAccountHistoryRepositoryShape["recordObservation"] = (
    observation,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM usage_account_snapshots
            WHERE account_key = ${observation.accountKey}
              AND account_identity <> ${observation.identity}
          `;
          yield* sql`
            DELETE FROM usage_quota_samples
            WHERE account_key = ${observation.accountKey}
              AND account_identity <> ${observation.identity}
          `;
          for (const snapshot of observation.snapshots) {
            yield* sql`
              INSERT INTO usage_account_snapshots (
                account_key, section_kind, account_identity, fetched_at, data_json
              ) VALUES (
                ${observation.accountKey}, ${snapshot.sectionKind}, ${observation.identity},
                ${snapshot.fetchedAt}, ${snapshot.dataJson}
              )
              ON CONFLICT (account_key, section_kind) DO UPDATE SET
                account_identity = excluded.account_identity,
                fetched_at = excluded.fetched_at,
                data_json = excluded.data_json
              WHERE excluded.fetched_at > usage_account_snapshots.fetched_at
            `;
          }
          for (const sample of observation.samples) {
            yield* sql`
              INSERT OR IGNORE INTO usage_quota_samples (
                account_key, window_key, account_identity, sampled_at, used_percent, resets_at
              ) VALUES (
                ${observation.accountKey}, ${sample.windowKey}, ${observation.identity},
                ${sample.sampledAt}, ${sample.usedPercent}, ${sample.resetsAt}
              )
            `;
          }
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("UsageAccountHistoryRepository.recordObservation")),
      );

  const deleteSnapshot: UsageAccountHistoryRepositoryShape["deleteSnapshot"] = (
    accountKey,
    sectionKind,
  ) =>
    sql`
      DELETE FROM usage_account_snapshots
      WHERE account_key = ${accountKey} AND section_kind = ${sectionKind}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("UsageAccountHistoryRepository.deleteSnapshot")),
    );

  const listSamplesSince: UsageAccountHistoryRepositoryShape["listSamplesSince"] = (sampledAt) =>
    sql<QuotaSampleRow>`
      SELECT
        account_key AS "accountKey",
        window_key AS "windowKey",
        account_identity AS "identity",
        sampled_at AS "sampledAt",
        used_percent AS "usedPercent",
        resets_at AS "resetsAt"
      FROM usage_quota_samples
      WHERE sampled_at >= ${sampledAt}
      ORDER BY account_key, window_key, sampled_at
    `.pipe(
      Effect.mapError(toPersistenceSqlError("UsageAccountHistoryRepository.listSamplesSince")),
    );

  const prune: UsageAccountHistoryRepositoryShape["prune"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM usage_quota_samples WHERE sampled_at < ${input.before}`;
          // Orphaned snapshots (removed instances) expire by age too. An
          // empty keep-list usually means the registry is momentarily empty,
          // so it never deletes snapshots.
          if (input.keepAccountKeys.length === 0) return;
          yield* sql`
            DELETE FROM usage_account_snapshots
            WHERE fetched_at < ${input.before}
              AND NOT (${sql.in("account_key", [...input.keepAccountKeys])})
          `;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("UsageAccountHistoryRepository.prune")));

  return {
    listSnapshots,
    recordObservation,
    deleteSnapshot,
    listSamplesSince,
    prune,
  } satisfies UsageAccountHistoryRepositoryShape;
});

export const UsageAccountHistoryRepositoryLive = Layer.effect(UsageAccountHistoryRepository, make);
