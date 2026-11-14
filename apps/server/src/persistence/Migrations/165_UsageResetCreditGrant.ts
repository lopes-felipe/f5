import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The Claude limit-reset grant a claim was sent for, so recovery replays the same grant. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE usage_reset_credit_requests ADD COLUMN grant_id TEXT`;
});
