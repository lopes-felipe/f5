import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A topic's decision history reads its ops by target; ops are never deleted, so index it. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS upstream_ledger_ops_target
    ON upstream_ledger_ops(project_id, kind, target, seq)`;
});
