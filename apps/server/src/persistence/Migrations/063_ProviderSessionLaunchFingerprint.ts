import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'provider_session_runtime'
  `;
  if (tables.length === 0) {
    return;
  }
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('provider_session_runtime')
    WHERE name = 'launch_fingerprint'
  `;
  if (columns.length === 0) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN launch_fingerprint TEXT
    `;
  }
});
