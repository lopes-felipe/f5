import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Turns the next-turn queue into a versioned state machine. Existing rows are
 * preserved and legacy `allow_after_error` values become the explicit failure
 * policy introduced by this migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE next_turn_queue RENAME TO next_turn_queue_legacy_057`;

  yield* sql`
    CREATE TABLE next_turn_queue (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL CHECK (position >= 0),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'dispatching', 'paused')),
      failure_policy TEXT NOT NULL DEFAULT 'stop'
        CHECK (failure_policy IN ('stop', 'continue')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      envelope_version INTEGER NOT NULL DEFAULT 1 CHECK (envelope_version >= 1),
      command_json TEXT NOT NULL,
      blocker_code TEXT,
      blocker_message TEXT,
      blocker_resumable INTEGER CHECK (blocker_resumable IN (0, 1)),
      dispatch_started_at TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (blocker_code IS NULL AND blocker_message IS NULL AND blocker_resumable IS NULL)
        OR
        (blocker_code IS NOT NULL AND blocker_message IS NOT NULL AND blocker_resumable IS NOT NULL)
      )
    )
  `;

  yield* sql`
    INSERT INTO next_turn_queue (
      item_id,
      thread_id,
      command_id,
      position,
      status,
      failure_policy,
      revision,
      envelope_version,
      command_json,
      blocker_code,
      blocker_message,
      blocker_resumable,
      dispatch_started_at,
      claimed_at,
      created_at,
      updated_at
    )
    SELECT
      item_id,
      thread_id,
      command_id,
      position,
      status,
      CASE WHEN allow_after_error = 1 THEN 'continue' ELSE 'stop' END,
      0,
      1,
      command_json,
      CASE WHEN status = 'paused' THEN 'queue_paused' ELSE NULL END,
      CASE
        WHEN status = 'paused' THEN COALESCE(last_error, 'Queue is paused.')
        ELSE NULL
      END,
      CASE WHEN status = 'paused' THEN 1 ELSE NULL END,
      dispatch_started_at,
      NULL,
      created_at,
      updated_at
    FROM next_turn_queue_legacy_057
  `;

  yield* sql`DROP TABLE next_turn_queue_legacy_057`;

  yield* sql`
    CREATE INDEX idx_next_turn_queue_thread_position
    ON next_turn_queue(thread_id, position, created_at)
  `;

  yield* sql`
    CREATE TABLE next_turn_queue_threads (
      thread_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO next_turn_queue_threads (thread_id, version, updated_at)
    SELECT thread_id, 1, MAX(updated_at)
    FROM next_turn_queue
    GROUP BY thread_id
  `;

  yield* sql`
    CREATE TABLE next_turn_queue_quarantine (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      envelope_version INTEGER NOT NULL,
      command_json TEXT NOT NULL,
      error TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_next_turn_queue_quarantine_thread
    ON next_turn_queue_quarantine(thread_id, quarantined_at)
  `;

  yield* sql`
    CREATE TABLE provider_turn_intent_receipts (
      command_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('dispatching', 'accepted', 'failed', 'delivery_unknown')),
      owner_id TEXT NOT NULL,
      error TEXT,
      attempted_at TEXT NOT NULL,
      accepted_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_provider_turn_intent_receipts_thread
    ON provider_turn_intent_receipts(thread_id, updated_at)
  `;
});
