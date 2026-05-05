import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'model_selection_json'
  `;

  if (columns.length === 0) {
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
