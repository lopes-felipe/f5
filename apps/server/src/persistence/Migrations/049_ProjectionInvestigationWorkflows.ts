import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_investigation_workflows (
      workflow_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_investigation_workflows_project
    ON projection_investigation_workflows(project_id, updated_at DESC)
  `;

  const legacyTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_debug_workflows'
  `;

  if (legacyTables.length > 0) {
    yield* sql`
      INSERT OR IGNORE INTO projection_investigation_workflows (
        workflow_id,
        project_id,
        workflow_json,
        updated_at,
        deleted_at
      )
      SELECT
        workflow_id,
        project_id,
        workflow_json,
        updated_at,
        deleted_at
      FROM projection_debug_workflows
    `;
  }
});
