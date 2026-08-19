import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs turn rows created from Codex collaboration-agent messages before
 * provider-thread routing was enforced. An auxiliary turn is projection-only:
 * it has an applied provider terminal receipt but was never accepted as the
 * thread session's active lifecycle turn.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const requiredTables = [
    "orchestration_events",
    "projection_thread_messages",
    "projection_turns",
    "provider_terminal_events",
  ];
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ${sql.in(requiredTables)}
  `;
  if (tables.length !== requiredTables.length) return;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_terminal_events_turn
    ON provider_terminal_events(thread_id, turn_id, event_type, applied_at)
  `;

  // These rows could only have been synthesized by the message projector: a
  // real parent turn always has a preceding session-set carrying activeTurnId.
  yield* sql`
    DELETE FROM projection_turns AS projected
    WHERE projected.turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM provider_terminal_events AS receipt
        WHERE receipt.thread_id = projected.thread_id
          AND receipt.turn_id = projected.turn_id
          AND receipt.event_type = 'turn.completed'
          AND receipt.applied_at IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projected.thread_id
          AND message.turn_id = projected.turn_id
          AND message.role = 'assistant'
          AND message.is_streaming = 0
          AND length(trim(message.text)) > 0
      )
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS lifecycle
        WHERE lifecycle.stream_id = projected.thread_id
          AND lifecycle.event_type = 'thread.session-set'
          AND json_extract(lifecycle.payload_json, '$.session.activeTurnId') = projected.turn_id
      )
  `;

  // If a real parent completion previously settled a newer auxiliary row,
  // project the applied receipt onto the exact accepted parent turn instead.
  yield* sql`
    UPDATE projection_turns AS projected
    SET
      state = CASE COALESCE((
        SELECT json_extract(receipt.event_json, '$.payload.state')
        FROM provider_terminal_events AS receipt
        WHERE receipt.thread_id = projected.thread_id
          AND receipt.turn_id = projected.turn_id
          AND receipt.event_type = 'turn.completed'
          AND receipt.applied_at IS NOT NULL
        ORDER BY receipt.received_at DESC, receipt.event_id DESC
        LIMIT 1
      ), 'completed')
        WHEN 'failed' THEN 'error'
        WHEN 'interrupted' THEN 'interrupted'
        WHEN 'cancelled' THEN 'interrupted'
        ELSE 'completed'
      END,
      completed_at = COALESCE(projected.completed_at, (
        SELECT json_extract(receipt.event_json, '$.createdAt')
        FROM provider_terminal_events AS receipt
        WHERE receipt.thread_id = projected.thread_id
          AND receipt.turn_id = projected.turn_id
          AND receipt.event_type = 'turn.completed'
          AND receipt.applied_at IS NOT NULL
        ORDER BY receipt.received_at DESC, receipt.event_id DESC
        LIMIT 1
      ))
    WHERE projected.turn_id IS NOT NULL
      AND projected.state = 'running'
      AND EXISTS (
        SELECT 1
        FROM provider_terminal_events AS receipt
        WHERE receipt.thread_id = projected.thread_id
          AND receipt.turn_id = projected.turn_id
          AND receipt.event_type = 'turn.completed'
          AND receipt.applied_at IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projected.thread_id
          AND message.turn_id = projected.turn_id
          AND message.role = 'assistant'
          AND message.is_streaming = 0
          AND length(trim(message.text)) > 0
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS lifecycle
        WHERE lifecycle.stream_id = projected.thread_id
          AND lifecycle.event_type = 'thread.session-set'
          AND json_extract(lifecycle.payload_json, '$.session.activeTurnId') = projected.turn_id
      )
  `;

  // Preserve a quiescence decision that was already durably recorded before
  // the incorrect running row caused the SQL projector to ignore it.
  yield* sql`
    UPDATE projection_turns AS projected
    SET processing_quiesced_at = COALESCE(projected.processing_quiesced_at, (
      SELECT json_extract(quiescence.payload_json, '$.processingQuiescedAt')
      FROM orchestration_events AS quiescence
      WHERE quiescence.stream_id = projected.thread_id
        AND quiescence.event_type = 'thread.turn-processing-quiesced'
        AND json_extract(quiescence.payload_json, '$.turnId') = projected.turn_id
      ORDER BY quiescence.sequence DESC
      LIMIT 1
    ))
    WHERE projected.turn_id IS NOT NULL
      AND projected.state IN ('completed', 'error', 'interrupted')
      AND projected.processing_quiesced_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS quiescence
        WHERE quiescence.stream_id = projected.thread_id
          AND quiescence.event_type = 'thread.turn-processing-quiesced'
          AND json_extract(quiescence.payload_json, '$.turnId') = projected.turn_id
      )
  `;
});
