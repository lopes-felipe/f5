import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('project_mcp_configs')
  `;

  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has("scope_key")) {
    yield* sql`
      CREATE TABLE project_mcp_configs_next (
        scope_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT,
        version TEXT NOT NULL,
        servers_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      INSERT INTO project_mcp_configs_next (
        scope_key,
        scope,
        project_id,
        version,
        servers_json,
        updated_at
      )
      SELECT
        'project:' || project_id,
        'project',
        project_id,
        version,
        servers_json,
        updated_at
      FROM project_mcp_configs
    `;

    yield* sql`
      DROP TABLE project_mcp_configs
    `;

    yield* sql`
      ALTER TABLE project_mcp_configs_next
      RENAME TO project_mcp_configs
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_mcp_configs_project_id
    ON project_mcp_configs(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_mcp_configs_updated_at
    ON project_mcp_configs(updated_at)
  `;
});
