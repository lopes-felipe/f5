import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX provider_terminal_events_retry_age ON provider_terminal_events(received_at) WHERE applied_at IS NULL AND attempt < 10`;
  yield* sql`CREATE INDEX provider_terminal_events_exhausted ON provider_terminal_events(thread_id) WHERE applied_at IS NULL AND attempt >= 10`;
});
