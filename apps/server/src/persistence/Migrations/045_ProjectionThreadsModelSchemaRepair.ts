import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases that advanced past migration 040 while still using an
 * older projection_threads shape without model or model_selection_json.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_threads'
  `;

  if (tables.length === 0) {
    return;
  }

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
  `;
  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has("model")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5-codex'
    `;
  }

  if (!existingColumns.has("model_selection_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model_selection_json TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_object(
      'instanceId',
      (
        SELECT COALESCE(session.provider_instance_id, session.provider_name)
        FROM projection_thread_sessions AS session
        WHERE session.thread_id = projection_threads.thread_id
        LIMIT 1
      ),
      'model',
      projection_threads.model
    )
    WHERE model_selection_json IS NULL
      AND model IS NOT NULL
      AND length(trim(model)) > 0
      AND (
        SELECT COALESCE(session.provider_instance_id, session.provider_name)
        FROM projection_thread_sessions AS session
        WHERE session.thread_id = projection_threads.thread_id
        LIMIT 1
      ) IS NOT NULL
  `;
});
