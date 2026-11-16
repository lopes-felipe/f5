import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keeps message-boundary fallback lookups bounded by the provider turn. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_provider_turn_deliveries_boundary
    ON provider_turn_deliveries(thread_id, provider_turn_id, state, created_at)`;
});
