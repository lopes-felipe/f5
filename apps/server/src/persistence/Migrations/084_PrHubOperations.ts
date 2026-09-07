import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_operations (
    provider_kind TEXT NOT NULL, host TEXT NOT NULL, viewer_id TEXT NOT NULL,
    repo TEXT NOT NULL, number INTEGER NOT NULL, operation_id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL, draft_version INTEGER NOT NULL,
    correlation_nonce TEXT NOT NULL, remote_id TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_kind, host, viewer_id, operation_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS pr_hub_operations_active_submission
    ON pr_hub_operations(provider_kind, host, viewer_id, repo, number)
    WHERE kind = 'review' AND status NOT IN ('succeeded', 'failed_before_send', 'rejected')`;
});
