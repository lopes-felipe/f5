import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cross-provider context handoff. The pending marker and parked native sessions
 * live outside `provider_session_runtime.runtime_payload_json`, which is
 * rewritten from stale snapshots by sends and orphan reconciliation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS provider_handoff_state (
    thread_id TEXT PRIMARY KEY,
    pending_json TEXT,
    parked_json TEXT NOT NULL DEFAULT '{}',
    retired_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`;
  // Idempotent: development databases ran an earlier form of this as migration 147.
  const columnsOf = (table: string) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );
  if (!(yield* columnsOf("provider_handoff_state")).has("retired_json"))
    yield* sql`ALTER TABLE provider_handoff_state ADD COLUMN retired_json TEXT NOT NULL DEFAULT '[]'`;
  // The prepared handoff of one delivery, reused byte-for-byte by its retries.
  if (!(yield* columnsOf("provider_turn_deliveries")).has("handoff_json"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN handoff_json TEXT`;
});
