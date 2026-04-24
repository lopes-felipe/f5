import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_code_review_workflows (
      workflow_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_code_review_workflows_project
    ON projection_code_review_workflows(project_id, updated_at DESC)
  `;
});
