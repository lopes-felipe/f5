import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The prompt cache indicator reads one thread's newest turn facts each time a
 * thread opens. Without this index that read scans every recorded turn.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS projection_turn_usage_facts_thread_completed_idx
    ON projection_turn_usage_facts(thread_id, completed_at)`;
});
