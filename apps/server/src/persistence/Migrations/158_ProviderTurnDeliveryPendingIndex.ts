import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The delivery sweep pages pending deliveries by thread. Nearly every row is
 * terminal, so walking the thread index visits the whole table to find a few
 * pending rows. This index holds only the pending ones, in sweep order.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_provider_turn_deliveries_pending_thread
    ON provider_turn_deliveries(thread_id, created_at)
    WHERE state = 'pending'`;
});
