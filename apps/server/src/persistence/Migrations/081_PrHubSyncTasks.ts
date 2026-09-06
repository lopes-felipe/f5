import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_sync_tasks (
    provider_kind TEXT NOT NULL, host TEXT NOT NULL, viewer_id TEXT NOT NULL,
    kind TEXT NOT NULL, task_key TEXT NOT NULL, payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lease_owner TEXT, lease_expires_at TEXT,
    PRIMARY KEY(provider_kind, host, viewer_id, kind, task_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pr_hub_sync_tasks_pending
    ON pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, created_at)`;
});
