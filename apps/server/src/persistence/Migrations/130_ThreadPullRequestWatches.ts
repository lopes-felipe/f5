import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_pull_request_watches (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    pr_key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    watch_id TEXT NOT NULL,
    watch_json TEXT NOT NULL CHECK(length(CAST(watch_json AS BLOB)) <= 65536),
    version INTEGER NOT NULL DEFAULT 0,
    read_failures INTEGER NOT NULL DEFAULT 0 CHECK(read_failures BETWEEN 0 AND 8),
    next_attempt_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, pr_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_pull_request_watch_stops (thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE, generation INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_pull_request_watches_account_pr ON thread_pull_request_watches(account_id, pr_key)`;
});
