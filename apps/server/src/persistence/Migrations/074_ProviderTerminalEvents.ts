import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_terminal_events (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('turn.completed', 'session.exited')),
      event_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      applied_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_terminal_events_pending
    ON provider_terminal_events(received_at, event_id)
    WHERE applied_at IS NULL
  `;
});
