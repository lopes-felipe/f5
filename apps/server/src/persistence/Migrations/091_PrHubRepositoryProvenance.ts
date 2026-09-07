import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_repository_provenance (
    provider_kind TEXT NOT NULL, host TEXT NOT NULL, viewer_id TEXT NOT NULL,
    repo TEXT NOT NULL, source TEXT NOT NULL, generation TEXT NOT NULL, node_id TEXT, archived INTEGER NOT NULL,
    PRIMARY KEY(provider_kind,host,viewer_id,repo,source)
  )`;
});
