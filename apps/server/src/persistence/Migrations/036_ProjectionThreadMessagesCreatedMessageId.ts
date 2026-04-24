import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_message_id
    ON projection_thread_messages(thread_id, created_at, message_id)
  `;
});
