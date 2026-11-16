import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE storage_automation_audit ADD COLUMN source TEXT NOT NULL DEFAULT 'automatic' CHECK(source IN ('automatic', 'manual'))`;
  yield* sql`ALTER TABLE storage_automation_audit ADD COLUMN category TEXT`;
  yield* sql`ALTER TABLE storage_automation_audit ADD COLUMN reason_code TEXT`;
  yield* sql`ALTER TABLE storage_automation_audit ADD COLUMN summary_json TEXT CHECK(summary_json IS NULL OR length(summary_json) <= 4096)`;
});
