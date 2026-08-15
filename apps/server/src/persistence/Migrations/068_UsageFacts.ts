import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_usage_metadata (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      coverage_started_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_usage_metadata (singleton_id, coverage_started_at)
    VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_usage_facts (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      provider_cost_usd REAL,
      token_provenance TEXT NOT NULL CHECK (
        token_provenance IN ('provider-reported', 'derived-from-provider-fields', 'unreported')
      ),
      cost_provenance TEXT NOT NULL CHECK (
        cost_provenance IN ('provider-reported', 'unreported')
      ),
      completed_at TEXT NOT NULL,
      source_event_id TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_turn_usage_facts_completed_idx
    ON projection_turn_usage_facts(completed_at, turn_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_turn_usage_facts_provider_completed_idx
    ON projection_turn_usage_facts(provider_name, completed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_turn_usage_facts_project_completed_idx
    ON projection_turn_usage_facts(project_id, completed_at)
  `;
});
