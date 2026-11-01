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
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`;
  // The prepared handoff of one delivery, reused byte-for-byte by its retries.
  // Idempotent: development databases ran this as migration 147 before main took it.
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('provider_turn_deliveries')`;
  if (!columns.some((column) => column.name === "handoff_json"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN handoff_json TEXT`;
});
