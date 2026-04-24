import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_command_executions (
      command_execution_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_item_id TEXT,
      command TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      output TEXT NOT NULL,
      output_truncated INTEGER NOT NULL,
      exit_code INTEGER,
      started_sequence INTEGER NOT NULL,
      last_updated_sequence INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_command_executions_thread_started
    ON projection_thread_command_executions(thread_id, started_at, started_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_command_executions_thread_last_updated
    ON projection_thread_command_executions(thread_id, last_updated_sequence)
  `;
});
