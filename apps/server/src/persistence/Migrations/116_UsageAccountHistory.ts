import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable account usage: the latest available snapshot per account section,
 * and quota utilization samples for history and forecasts. Rows carry a hashed
 * account identity so a configuration change discards stale history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_account_snapshots (
      account_key TEXT NOT NULL,
      section_kind TEXT NOT NULL,
      account_identity TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (account_key, section_kind)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_quota_samples (
      account_key TEXT NOT NULL,
      window_key TEXT NOT NULL,
      account_identity TEXT NOT NULL,
      sampled_at TEXT NOT NULL,
      used_percent REAL NOT NULL,
      resets_at TEXT,
      PRIMARY KEY (account_key, window_key, sampled_at)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS usage_quota_samples_sampled_idx
    ON usage_quota_samples(sampled_at)
  `;
});
