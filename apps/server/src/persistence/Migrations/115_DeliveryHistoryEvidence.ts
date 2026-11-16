import { ensureProviderTurnDeliveriesSchema } from "./ProviderTurnDeliveriesSchema";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureProviderTurnDeliveriesSchema;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('provider_turn_deliveries')`;
  if (!columns.some((column) => column.name === "history_evidence_json"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN history_evidence_json TEXT`;
  if (!columns.some((column) => column.name === "attempt_id"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN attempt_id TEXT`;
  if (!columns.some((column) => column.name === "reservation_released_at"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN reservation_released_at TEXT`;
  if (!columns.some((column) => column.name === "acceptance_receipt_json"))
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN acceptance_receipt_json TEXT`;
  yield* sql`UPDATE provider_turn_deliveries SET reservation_released_at = updated_at WHERE state IN ('rejected', 'abandoned')`;
  // Historical accepted rows have no reservation record. Preserve only owners
  // whose native turn is still active; missing/rewound projections cannot block forever.
  const projectionTables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projection_turns', 'projection_thread_sessions')`;
  // Older schema-repair databases may not yet have projections to inspect.
  if (projectionTables.length === 2)
    yield* sql`UPDATE provider_turn_deliveries AS d SET reservation_released_at = updated_at
    WHERE state = 'accepted' AND reservation_released_at IS NULL AND (
      EXISTS (SELECT 1 FROM projection_turns t WHERE t.thread_id = d.thread_id AND t.turn_id = d.provider_turn_id AND t.completed_at IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = d.thread_id AND (s.status = 'starting' OR (s.status = 'running' AND (s.active_turn_id IS NULL OR s.active_turn_id = d.provider_turn_id)))))`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_delivery_thread_state_due ON provider_turn_deliveries(thread_id, state, not_before, created_at)`;
});
