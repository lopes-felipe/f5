import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_pending_user_inputs (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, payload_json TEXT NOT NULL, resolution TEXT,
    PRIMARY KEY (thread_id, request_id)
  )`;
});
