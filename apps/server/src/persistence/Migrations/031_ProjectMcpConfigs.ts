import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_mcp_configs (
      project_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      servers_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_mcp_configs_updated_at
    ON project_mcp_configs(updated_at)
  `;
});
