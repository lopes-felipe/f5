import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('provider_session_runtime')
    WHERE name IN ('project_id', 'mcp_config_version')
  `;

  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has("project_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN project_id TEXT
    `;
  }

  if (!existingColumns.has("mcp_config_version")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN mcp_config_version TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_project
    ON provider_session_runtime(project_id)
  `;
});
