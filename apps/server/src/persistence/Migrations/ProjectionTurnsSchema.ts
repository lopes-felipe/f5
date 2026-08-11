import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds the processing-quiescence marker to an existing projection-turn table.
 *
 * Some development databases recorded the migration that introduced this
 * column before the column was part of that migration. A missing table is left
 * to the full projection-schema repair because there is no data to preserve.
 */
export const ensureProjectionTurnsProcessingQuiescedColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_turns')
  `;

  if (columns.length > 0 && !columns.some((column) => column.name === "processing_quiesced_at")) {
    yield* sql`ALTER TABLE projection_turns ADD COLUMN processing_quiesced_at TEXT`;
  }
});
