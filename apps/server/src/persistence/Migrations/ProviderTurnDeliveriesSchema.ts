import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Ensures the durable provider-turn delivery schema exists at its latest shape.
 *
 * This is shared by the introducing migration and the following repair migration
 * because development databases may have already recorded migration 58 before
 * the delivery table was added to it.
 */
export const ensureProviderTurnDeliveriesSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_deliveries (
      delivery_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'sending', 'accepted', 'rejected', 'ambiguous', 'abandoned')
      ),
      provider_turn_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      pre_send_turn_ids_json TEXT NOT NULL DEFAULT '[]',
      event_json TEXT NOT NULL,
      error_code TEXT,
      error_detail TEXT,
      certainty TEXT CHECK (certainty IS NULL OR certainty IN ('not_sent', 'unknown')),
      not_before TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      outcome_projected_at TEXT
    )
  `;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('provider_turn_deliveries')
  `;
  if (!columns.some((column) => column.name === "outcome_projected_at")) {
    yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN outcome_projected_at TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_turn_deliveries_actionable
    ON provider_turn_deliveries(state, not_before, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_turn_deliveries_thread
    ON provider_turn_deliveries(thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_turn_deliveries_unprojected
    ON provider_turn_deliveries(state, outcome_projected_at, updated_at)
  `;
});
