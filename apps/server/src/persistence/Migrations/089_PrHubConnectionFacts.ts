import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_connection_facts (
    provider_kind TEXT NOT NULL, host TEXT NOT NULL, viewer_id TEXT NOT NULL,
    task_kind TEXT NOT NULL, task_key TEXT NOT NULL, comparison TEXT NOT NULL,
    node_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(provider_kind, host, viewer_id, task_kind, task_key, comparison, node_id)
  )`;
});
