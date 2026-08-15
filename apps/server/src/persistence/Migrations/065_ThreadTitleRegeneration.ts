import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("title_source")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'
    `;
  }
  if (!names.has("title_revision")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!names.has("title_updated_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_updated_at TEXT`;
  }
  if (!names.has("title_regeneration_request_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_regeneration_request_id TEXT`;
  }
  if (!names.has("title_regeneration_started_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_regeneration_started_at TEXT`;
  }
});
