import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_reply_drafts (
    provider_kind TEXT NOT NULL, host TEXT NOT NULL, viewer_id TEXT NOT NULL,
    repo TEXT NOT NULL, number INTEGER NOT NULL, thread_id TEXT NOT NULL,
    version INTEGER NOT NULL, body TEXT NOT NULL, comparison_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_kind, host, viewer_id, repo, number, thread_id)
  )`;
});
