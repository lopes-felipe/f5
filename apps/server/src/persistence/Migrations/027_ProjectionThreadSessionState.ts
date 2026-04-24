import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name IN ('session_notes_json', 'thread_references_json')
  `;

  const existingColumns = new Set(existing.map((row) => row.name));

  if (!existingColumns.has("session_notes_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN session_notes_json TEXT
    `;
  }

  if (!existingColumns.has("thread_references_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN thread_references_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET thread_references_json = '[]'
    WHERE thread_references_json IS NULL
  `;
});
