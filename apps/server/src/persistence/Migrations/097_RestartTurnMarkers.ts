import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE restart_turn_markers(thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE, turn_id TEXT NOT NULL, marked_at TEXT NOT NULL, continuation_id TEXT NOT NULL UNIQUE)`;
  yield* sql`CREATE TABLE restart_continuations(continuation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE, provider_turn_id TEXT)`;
});
