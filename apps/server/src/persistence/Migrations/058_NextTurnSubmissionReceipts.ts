import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds end-to-end submit idempotency and marks pre-reliability provider
 * intents accepted so the first upgrade replay cannot resend old prompts.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Repair databases whose migration ledger advanced past 057 while the
  // receipt table was absent (for example, interrupted development builds).
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_intent_receipts (
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
    CREATE INDEX IF NOT EXISTS idx_provider_turn_intent_receipts_thread
    ON provider_turn_intent_receipts(thread_id, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS next_turn_submission_receipts (
      item_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (
          status IN (
            'claimed',
            'starting',
            'steering',
            'started',
            'steered',
            'delivery_unknown'
          )
        ),
      owner_id TEXT NOT NULL,
      sequence INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (status = 'started' AND sequence IS NOT NULL)
        OR (status <> 'started' AND sequence IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_next_turn_submission_receipts_thread
    ON next_turn_submission_receipts(thread_id, updated_at)
  `;

  // Migration 057 introduced an empty receipt table while the provider
  // reactor still replays historical turn-start events from sequence zero.
  // Backfill those events before runtime startup to make the upgrade safe.
  const orchestrationEventTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'orchestration_events'
  `;
  if (orchestrationEventTables.length > 0) {
    yield* sql`
      INSERT INTO provider_turn_intent_receipts (
        command_id,
        event_id,
        thread_id,
        status,
        owner_id,
        error,
        attempted_at,
        accepted_at,
        updated_at
      )
      SELECT
        COALESCE(command_id, event_id),
        event_id,
        stream_id,
        'accepted',
        'migration:058',
        NULL,
        occurred_at,
        occurred_at,
        occurred_at
      FROM orchestration_events
      WHERE event_type = 'thread.turn-start-requested'
      ON CONFLICT DO NOTHING
    `;
  }
});
