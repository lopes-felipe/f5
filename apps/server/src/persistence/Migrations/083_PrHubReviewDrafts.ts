import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_review_drafts (
    provider_kind TEXT NOT NULL,
    host TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    version INTEGER NOT NULL,
    comparison_json TEXT NOT NULL,
    content_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    frozen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_kind, host, viewer_id, repo, number)
  )`;
});
