import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Rebaseline old attention identities once, without losing genuinely pending work. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('pr_hub_viewer_state')`;
  // Repair migrations also run against databases with only a subset of tables.
  if (columns.length === 0 || columns.some((column) => column.name === "attention_model_version"))
    return;
  yield* sql`ALTER TABLE pr_hub_viewer_state ADD COLUMN attention_model_version INTEGER NOT NULL DEFAULT 1`;
});
