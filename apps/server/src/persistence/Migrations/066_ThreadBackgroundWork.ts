import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_background_work (
      thread_id TEXT NOT NULL,
      provider_work_item_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT,
      provider_session_identity TEXT,
      turn_id TEXT,
      classification TEXT NOT NULL CHECK (classification IN ('working', 'monitoring', 'inert')),
      ownership TEXT NOT NULL CHECK (ownership IN ('direct-subagent', 'workflow')),
      status TEXT NOT NULL CHECK (
        status IN ('running', 'monitoring', 'idle', 'completed', 'failed', 'stopped', 'interrupted')
      ),
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      model TEXT,
      phase TEXT,
      latest_output TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (thread_id, provider_work_item_id),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_thread_background_work_liveness_idx
    ON projection_thread_background_work(thread_id, active, classification, last_seen_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_thread_background_work_snapshot_idx
    ON projection_thread_background_work(updated_at DESC, thread_id, provider_work_item_id)
  `;
});
