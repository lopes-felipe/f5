import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration051 from "./051_PrHub.ts";
import Migration053 from "./053_PrHubAdvisories.ts";
import Migration069 from "./069_PrProviderDiscriminant.ts";
import Migration072 from "./072_PrProviderQualifiedKeys.ts";
import Migration078 from "./078_PrHubViewerIsolation.ts";
import Migration082 from "./082_PrHubCoverage.ts";

it.layer(SqliteClient.layerMemory())("082_PrHubCoverage", (it) => {
  it.effect("preserves legacy limits as unverified coverage and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration051;
      yield* Migration053;
      yield* Migration069;
      yield* Migration072;
      yield* Migration078;
      for (const [viewer, limits] of [
        ["1", '["authored"]'],
        ["2", "malformed legacy JSON"],
        ["3", "[]"],
      ]) {
        yield* sql`INSERT INTO pr_hub_refresh_state
          (provider_kind, host, viewer_id, viewer_login, status, capped_buckets_json)
          VALUES ('github', 'github.com', ${viewer}, 'octo', 'ready', ${limits})`;
      }
      yield* Migration082;
      yield* Migration082;
      const rows = yield* sql<{ viewer_id: string; coverage_json: string }>`
        SELECT viewer_id, coverage_json FROM pr_hub_refresh_state ORDER BY viewer_id`;
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.deepStrictEqual(JSON.parse(row.coverage_json), [
          {
            scope: "global_relationship_search",
            status: "partial",
            description: "Legacy search coverage has not been verified.",
            limits: row.viewer_id === "1" ? ["authored"] : [],
          },
        ]);
      }
      const columns = yield* sql<{ name: string }>`
        SELECT name FROM pragma_table_info('pr_hub_refresh_state')`;
      assert.equal(
        columns.some((column) => column.name === "capped_buckets_json"),
        false,
      );
    }),
  );
});
