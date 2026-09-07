import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('pr_hub_viewer_state')`;
  if (columns.length === 0) return;
  for (const column of [
    "notification_lease_owner",
    "notification_lease_expires_at",
    "notification_claimed_version",
    "notification_batch_id",
  ]) {
    if (!columns.some((existing) => existing.name === column))
      yield* sql.unsafe(`ALTER TABLE pr_hub_viewer_state ADD COLUMN ${column} TEXT`);
  }
});
