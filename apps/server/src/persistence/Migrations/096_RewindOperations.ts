import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE rewind_operations (
    operation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    target_message_id TEXT NOT NULL, target_turn_id TEXT, provider_session_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('conversation', 'conversation-and-files')),
    expected_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('prepared', 'provider-pending', 'provider-confirmed', 'files-confirmed', 'completed', 'reconciliation-required')),
    relative_count INTEGER NOT NULL, retained_count INTEGER NOT NULL, boundary_json TEXT NOT NULL,
    draft_json TEXT NOT NULL, draft_resolved_at TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE rewind_requests(operation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE REFERENCES projection_threads(thread_id) ON DELETE CASCADE, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, queue_state_json TEXT)`;
  yield* sql`CREATE UNIQUE INDEX idx_rewind_operations_active ON rewind_operations(thread_id) WHERE state <> 'completed'`;
});
