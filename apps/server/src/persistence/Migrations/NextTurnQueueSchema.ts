import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Ensures the durable next-turn queue schema exists at its latest shape.
 *
 * The legacy queue cannot be upgraded in place because its delivery semantics
 * are incompatible with submission-ledger idempotency. Preserve attachment
 * ownership for cleanup, then rebuild the queue tables when legacy columns are
 * detected.
 */
export const ensureNextTurnQueueSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS next_turn_queue_orphaned_attachments (
      attachment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;

  const existingColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('next_turn_queue')
  `;
  const alreadyRebuilt = existingColumns.some((column) => column.name === "submission_id");

  if (existingColumns.length > 0 && !alreadyRebuilt) {
    const recordedAt = new Date().toISOString();
    yield* sql`
      INSERT OR IGNORE INTO next_turn_queue_orphaned_attachments (
        attachment_id,
        thread_id,
        recorded_at
      )
      SELECT
        json_extract(attachment.value, '$.id'),
        queue.thread_id,
        ${recordedAt}
      FROM next_turn_queue AS queue,
           json_each(json_extract(queue.command_json, '$.message.attachments')) AS attachment
      WHERE json_type(attachment.value, '$.id') = 'text'
    `;
    yield* sql`DROP TABLE next_turn_queue`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS next_turn_queue (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'dispatching', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      not_before TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      dispatch_started_at TEXT,
      command_json TEXT NOT NULL,
      last_error_code TEXT,
      last_error_detail TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS next_turn_queue_state (
      thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      pause_reason_code TEXT,
      pause_detail TEXT,
      resumed_at TEXT,
      interrupt_suppression_command_id TEXT,
      worktree_block_token TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS turn_submissions (
      submission_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      request_hash TEXT NOT NULL,
      item_id TEXT,
      message_id TEXT NOT NULL,
      disposition TEXT NOT NULL
        CHECK (disposition IN ('pending', 'started', 'queued', 'canceled', 'cleared', 'rejected')),
      result_sequence INTEGER,
      reason_code TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS next_turn_queue_quarantine (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_json TEXT NOT NULL,
      detail TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_next_turn_queue_thread_position
    ON next_turn_queue(thread_id, position)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_next_turn_queue_actionable
    ON next_turn_queue(status, deleted_at, not_before)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_next_turn_queue_leases
    ON next_turn_queue(status, lease_expires_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_turn_submissions_thread_settled
    ON turn_submissions(thread_id, settled_at)
  `;
});
