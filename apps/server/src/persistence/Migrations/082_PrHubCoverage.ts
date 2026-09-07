import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('pr_hub_refresh_state')`;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "coverage_json")) {
    yield* sql`ALTER TABLE pr_hub_refresh_state ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`UPDATE pr_hub_refresh_state SET coverage_json = json_array(json_object(
      'scope', 'global_relationship_search', 'status', 'partial',
      'description', 'Legacy search coverage has not been verified.',
      'limits', json(CASE WHEN json_valid(capped_buckets_json) THEN capped_buckets_json ELSE '[]' END)))`;
  }
  if (columns.some((column) => column.name === "capped_buckets_json"))
    yield* sql`ALTER TABLE pr_hub_refresh_state DROP COLUMN capped_buckets_json`;
});
