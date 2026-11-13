import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_turn_usage_facts')`;
  if (!columns.some((column) => column.name === "native_session_id"))
    yield* sql`ALTER TABLE projection_turn_usage_facts ADD COLUMN native_session_id TEXT`;
  if (!columns.some((column) => column.name === "started_at"))
    yield* sql`ALTER TABLE projection_turn_usage_facts ADD COLUMN started_at TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS projection_usage_native_intervals
    ON projection_turn_usage_facts(native_session_id, started_at, completed_at)
    WHERE provider_name = 'muse' AND native_session_id IS NOT NULL
      AND started_at IS NOT NULL AND total_tokens IS NOT NULL`;
  // Terminal receipts retain the original session cursor even after session replacement.
  // Do not infer identity from today's provider_session_runtime row.
  const receipts =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_terminal_events'`;
  if (receipts.length) {
    yield* sql`
      UPDATE projection_turn_usage_facts AS f
      SET native_session_id = (
        SELECT json_extract(e.event_json, '$.resumeCursor.mspSessionId')
        FROM provider_terminal_events e
        WHERE e.event_id = f.source_event_id AND json_valid(e.event_json)
      ), started_at = (
        SELECT COALESCE(t.started_at, t.requested_at) FROM projection_turns t
        WHERE t.thread_id = f.thread_id AND t.turn_id = f.turn_id LIMIT 1
      )
      WHERE provider_name = 'muse' AND native_session_id IS NULL
    `;
  }
});
