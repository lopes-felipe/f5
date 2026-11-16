import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep malformed operational evidence without letting it poison healthy schedules. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_task_quarantine (
    entity_kind TEXT NOT NULL CHECK(entity_kind IN ('task','run')),
    entity_id TEXT NOT NULL,
    thread_id TEXT,
    payload_json TEXT NOT NULL,
    detail TEXT NOT NULL,
    quarantined_at TEXT NOT NULL,
    PRIMARY KEY(entity_kind,entity_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_submission_parent
    ON scheduled_run_submissions(run_id,parent_submission_id,recovery_decision)`;
});
