import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const speedColumn = yield* sql`
    SELECT name FROM pragma_table_info('projection_turn_usage_facts') WHERE name = 'usage_speed'
  `;
  if (speedColumn.length === 0) {
    yield* sql`ALTER TABLE projection_turn_usage_facts ADD COLUMN usage_speed TEXT`;
  }
  const receipts =
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'provider_terminal_events' AND type = 'table'`;
  if (receipts.length)
    yield* sql`
    UPDATE projection_turn_usage_facts AS f
    SET native_session_id = (
      SELECT json_extract(e.event_json, '$.resumeCursor.sessionId')
      FROM provider_terminal_events e
      WHERE e.event_id = f.source_event_id AND json_valid(e.event_json)
    ), started_at = (
      SELECT COALESCE(t.started_at, t.requested_at) FROM projection_turns t
      WHERE t.thread_id = f.thread_id AND t.turn_id = f.turn_id LIMIT 1
    )
    WHERE provider_name IN ('cursor', 'opencode', 'antigravity') AND native_session_id IS NULL
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS projection_usage_external_intervals
    ON projection_turn_usage_facts(provider_name, native_session_id, started_at, completed_at)
    WHERE provider_name IN ('cursor', 'opencode', 'antigravity')
      AND native_session_id IS NOT NULL AND started_at IS NOT NULL AND total_tokens IS NOT NULL`;
});
