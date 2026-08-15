import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration069 from "./069_PrProviderDiscriminant.ts";

it.layer(SqliteClient.layerMemory())("069_PrProviderDiscriminant", (it) => {
  it.effect("adds the GitHub provider discriminant and qualifies persisted PR keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE pr_hub_prs (host TEXT, repo TEXT, number INTEGER)`;
      yield* sql`CREATE TABLE pr_hub_viewer_state (host TEXT, viewer_login TEXT)`;
      yield* sql`CREATE TABLE pr_hub_refresh_state (host TEXT, viewer_login TEXT)`;
      yield* sql`
      CREATE TABLE pr_hub_advisories (
        host TEXT,
        viewer_login TEXT,
        key TEXT
      )
    `;
      yield* sql`
      INSERT INTO pr_hub_advisories (host, viewer_login, key)
      VALUES ('github.com', 'octo', 'github.com/octo/repo#17')
    `;

      yield* Migration069;
      yield* Migration069;

      const tables = yield* Effect.forEach(
        ["pr_hub_prs", "pr_hub_viewer_state", "pr_hub_refresh_state", "pr_hub_advisories"],
        (table) =>
          sql<{ readonly name: string; readonly dfltValue: string | null }>`
          SELECT name, dflt_value AS "dfltValue"
          FROM pragma_table_info(${table})
          WHERE name = 'provider_kind'
        `.pipe(Effect.map((rows) => rows[0])),
      );
      assert.deepStrictEqual(
        tables.map((row) => row?.name),
        ["provider_kind", "provider_kind", "provider_kind", "provider_kind"],
      );
      assert.ok(tables.every((row) => row?.dfltValue === "'github'"));

      const rows = yield* sql<{ readonly provider: string; readonly key: string }>`
      SELECT provider_kind AS provider, key FROM pr_hub_advisories
    `;
      assert.deepStrictEqual(rows, [{ provider: "github", key: "github:github.com/octo/repo#17" }]);
    }),
  );
});
