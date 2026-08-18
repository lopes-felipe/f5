import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const metadataColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_usage_metadata')
  `;
  if (!metadataColumns.some((column) => column.name === "fact_cutover_at")) {
    yield* sql`
      ALTER TABLE projection_usage_metadata
      ADD COLUMN fact_cutover_at TEXT
    `;
  }
  yield* sql`
    UPDATE projection_usage_metadata
    SET fact_cutover_at = coverage_started_at
    WHERE fact_cutover_at IS NULL
  `;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_turn_usage_facts')
  `;
  if (!columns.some((column) => column.name === "recorded_at")) {
    yield* sql`
      ALTER TABLE projection_turn_usage_facts
      ADD COLUMN recorded_at TEXT
    `;
  }
  yield* sql`
    UPDATE projection_turn_usage_facts
    SET recorded_at = (
      SELECT fact_cutover_at
      FROM projection_usage_metadata
      WHERE singleton_id = 1
    )
    WHERE recorded_at IS NULL
  `;
});
