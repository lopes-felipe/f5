import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'orchestration_events'
  `;
  if (tables.length === 0) return;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_type_occurred_at
    ON orchestration_events(event_type, occurred_at)
  `;
});
