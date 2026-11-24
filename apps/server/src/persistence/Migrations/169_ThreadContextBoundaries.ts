import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(
    "CREATE TABLE IF NOT EXISTS thread_context_boundaries (thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE, message_id TEXT NOT NULL, created_at TEXT NOT NULL, prepared INTEGER NOT NULL DEFAULT 0)",
  );
});
