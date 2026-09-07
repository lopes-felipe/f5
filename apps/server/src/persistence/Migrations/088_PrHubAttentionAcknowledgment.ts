import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('pr_hub_viewer_state')`;
  // Repair fixtures and partially initialized installations may not yet own PR Hub tables.
  if (!columns.length) return;
  if (!columns.some((column) => column.name === "last_acknowledged_fingerprint"))
    yield* sql`ALTER TABLE pr_hub_viewer_state ADD COLUMN last_acknowledged_fingerprint TEXT`;
  if (!columns.some((column) => column.name === "acknowledged_at"))
    yield* sql`ALTER TABLE pr_hub_viewer_state ADD COLUMN acknowledged_at TEXT`;
});
