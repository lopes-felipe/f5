import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Human sends supersede delayed Stop events without acknowledging provider errors. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE next_turn_queue_state ADD COLUMN last_human_send_sequence INTEGER`;
});
