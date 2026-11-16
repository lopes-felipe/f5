import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX provider_terminal_events_due ON provider_terminal_events(next_due_at, received_at, event_id) WHERE applied_at IS NULL`;
  yield* sql`CREATE INDEX provider_terminal_events_pending_thread ON provider_terminal_events(thread_id, turn_id) WHERE applied_at IS NULL`;
});
