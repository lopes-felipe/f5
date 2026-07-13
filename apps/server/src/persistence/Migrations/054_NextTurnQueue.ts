import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS next_turn_queue (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL CHECK (position >= 0),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'paused')),
      allow_after_error INTEGER NOT NULL DEFAULT 0 CHECK (allow_after_error IN (0, 1)),
      command_json TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_next_turn_queue_thread_position
    ON next_turn_queue(thread_id, position, created_at)
  `;
});
