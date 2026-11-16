import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing attempt/last_error columns remain authoritative for legacy receipts.
  yield* sql`ALTER TABLE provider_terminal_events ADD COLUMN origin_provider_instance_id TEXT`;
  yield* sql`ALTER TABLE provider_terminal_events ADD COLUMN origin_session_generation INTEGER`;
  yield* sql`ALTER TABLE provider_terminal_events ADD COLUMN origin_turn_id TEXT`;
  yield* sql`ALTER TABLE provider_terminal_events ADD COLUMN next_due_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`;
});
