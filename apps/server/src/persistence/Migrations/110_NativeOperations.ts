import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE native_operations (
    operation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
    generation INTEGER NOT NULL, state TEXT NOT NULL,
    record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  // An indeterminate operation keeps its reservation until explicit reconciliation.
  yield* sql`CREATE UNIQUE INDEX native_operations_thread_active ON native_operations(thread_id)
    WHERE state IN ('requested', 'dispatched', 'running', 'indeterminate')`;
  yield* sql`CREATE INDEX native_operations_thread_history ON native_operations(thread_id, created_at)`;
});
