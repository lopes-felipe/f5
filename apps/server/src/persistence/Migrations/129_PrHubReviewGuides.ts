import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_review_guides (
    account_id TEXT NOT NULL,
    pr_key TEXT NOT NULL,
    head_sha TEXT,
    guide_json TEXT CHECK(guide_json IS NULL OR length(CAST(guide_json AS BLOB)) <= 262144),
    run_json TEXT CHECK(run_json IS NULL OR length(CAST(run_json AS BLOB)) <= 4096),
    run_id TEXT,
    PRIMARY KEY(account_id, pr_key)
  )`;
});
