import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_transitions (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX workspace_transitions_active_thread ON workspace_transitions(thread_id)
    WHERE phase IN ('reserved', 'stopping', 'applying', 'applied', 'needs_recovery')`;
  yield* sql`CREATE INDEX workspace_transitions_thread_history ON workspace_transitions(thread_id, created_at DESC)`;
});
