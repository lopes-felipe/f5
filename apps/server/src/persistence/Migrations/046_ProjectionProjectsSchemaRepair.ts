import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases that advanced past migration 041 while projection_projects
 * was missing columns required by startup snapshot queries.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_projects'
  `;

  if (tables.length === 0) {
    yield* sql`
      CREATE TABLE projection_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        default_model TEXT,
        scripts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        default_model_selection_json TEXT
      )
    `;
  }

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_projects')
  `;
  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has("title")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN title TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!existingColumns.has("workspace_root")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_root TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!existingColumns.has("default_model")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_model TEXT
    `;
  }

  if (!existingColumns.has("scripts_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN scripts_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  if (!existingColumns.has("created_at")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!existingColumns.has("updated_at")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!existingColumns.has("deleted_at")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN deleted_at TEXT
    `;
  }

  if (!existingColumns.has("default_model_selection_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_model_selection_json TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  `;
});
