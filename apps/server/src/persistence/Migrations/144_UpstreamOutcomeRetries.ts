import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE upstream_port_outcome_checks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE upstream_port_outcome_checks ADD COLUMN retry_at TEXT`;
});
