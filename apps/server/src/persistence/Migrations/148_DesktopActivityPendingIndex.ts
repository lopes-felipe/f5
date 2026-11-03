import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_turns_recent_pending
    ON projection_turns(requested_at, thread_id)
    WHERE turn_id IS NULL AND state = 'pending'
      AND pending_message_id IS NOT NULL AND checkpoint_turn_count IS NULL`;
});
