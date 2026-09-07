import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pr_hub_publication (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT OR IGNORE INTO pr_hub_publication(id, revision) VALUES (1, 0)`;
});
