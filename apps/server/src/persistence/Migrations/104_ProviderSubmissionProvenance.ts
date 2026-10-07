import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS provider_submission_provenance (
    command_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('human', 'automation')),
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS provider_submission_provenance_thread ON provider_submission_provenance(thread_id)`;
});
