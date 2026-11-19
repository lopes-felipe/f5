import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE provider_turn_deliveries ADD COLUMN benchmark_reverted_at TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delivery_workflow_benchmark ON provider_turn_deliveries (
      json_extract(event_json, '$.payload.workflowAttribution.runKind'),
      json_extract(event_json, '$.payload.workflowAttribution.workflowId'),
      json_extract(event_json, '$.payload.workflowAttribution.taskId'),
      created_at, delivery_id
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delivery_workflow_attempt ON provider_turn_deliveries (
      json_extract(event_json, '$.payload.workflowAttribution.originCommandId'), thread_id
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_benchmark_outputs (
      run_kind TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      message_id TEXT,
      plan_id TEXT,
      kind TEXT NOT NULL,
      coverage TEXT NOT NULL,
      metadata_json TEXT,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (run_kind, workflow_id, task_id, turn_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_benchmark_output_thread
    ON workflow_benchmark_outputs(thread_id, turn_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_benchmark_artifacts (
      run_kind TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      kind TEXT NOT NULL,
      coverage TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (thread_id, turn_id, artifact_kind, artifact_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_benchmark_artifact_run
    ON workflow_benchmark_artifacts(run_kind, workflow_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_benchmark_turn_models (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      model TEXT NOT NULL,
      rerouted INTEGER NOT NULL,
      reported_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_benchmark_cutover (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      started_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO workflow_benchmark_cutover VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
