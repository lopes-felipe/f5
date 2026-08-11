import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Marks terminal turns that predate the processing-quiescence schema repair as
 * already settled. Without this backfill, every historical terminal turn is
 * replayed through checkpoint reconciliation during the next startup.
 *
 * The migration-61 timestamp bounds the update so a genuinely unquiesced turn
 * completed after the repair remains eligible for crash recovery.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const turnColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_turns')
  `;
  const columnNames = new Set(turnColumns.map((column) => column.name));
  const requiredColumns = [
    "turn_id",
    "state",
    "requested_at",
    "started_at",
    "completed_at",
    "processing_quiesced_at",
  ];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return;
  }

  yield* sql`
    UPDATE projection_turns
    SET processing_quiesced_at = COALESCE(completed_at, started_at, requested_at)
    WHERE turn_id IS NOT NULL
      AND state IN ('interrupted', 'completed', 'error')
      AND processing_quiesced_at IS NULL
      AND julianday(COALESCE(completed_at, started_at, requested_at)) <= julianday((
        SELECT created_at
        FROM effect_sql_migrations
        WHERE migration_id = 61
      ))
  `;
});
