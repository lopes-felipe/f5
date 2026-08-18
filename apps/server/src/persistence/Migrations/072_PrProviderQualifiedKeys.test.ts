import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration051 from "./051_PrHub.ts";
import Migration053 from "./053_PrHubAdvisories.ts";
import Migration069 from "./069_PrProviderDiscriminant.ts";
import Migration072 from "./072_PrProviderQualifiedKeys.ts";

it.layer(SqliteClient.layerMemory())("072_PrProviderQualifiedKeys", (it) => {
  it.effect("allows two providers to persist the same host/repository identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration051;
      yield* Migration053;
      yield* Migration069;
      yield* Migration072;
      yield* Migration072;

      yield* sql`
        INSERT INTO pr_hub_refresh_state (
          provider_kind, host, viewer_login, status, capped_buckets_json
        ) VALUES ('github', 'scm.example', 'octo', 'ready', '[]')
      `;
      yield* sql`
        INSERT INTO pr_hub_refresh_state (
          provider_kind, host, viewer_login, status, capped_buckets_json
        ) VALUES ('gitlab', 'scm.example', 'octo', 'ready', '[]')
      `;

      const rows = yield* sql<{ readonly provider: string }>`
        SELECT provider_kind AS provider
        FROM pr_hub_refresh_state
        ORDER BY provider_kind
      `;
      assert.deepStrictEqual(rows, [{ provider: "github" }, { provider: "gitlab" }]);

      const primaryKey = yield* sql<{ readonly name: string; readonly pk: number }>`
        SELECT name, pk FROM pragma_table_info('pr_hub_refresh_state') WHERE pk > 0 ORDER BY pk
      `;
      assert.deepStrictEqual(
        primaryKey.map((column) => column.name),
        ["provider_kind", "host", "viewer_login"],
      );
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_pr_hub_prs_provider_host',
          'idx_pr_hub_viewer_provider_host',
          'idx_pr_hub_refresh_provider_host',
          'idx_pr_hub_advisories_provider_host'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        [
          "idx_pr_hub_advisories_provider_host",
          "idx_pr_hub_prs_provider_host",
          "idx_pr_hub_refresh_provider_host",
          "idx_pr_hub_viewer_provider_host",
        ],
      );
    }),
  );
});
