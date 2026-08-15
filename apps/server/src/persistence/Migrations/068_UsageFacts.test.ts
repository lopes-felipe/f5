import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0068 from "./068_UsageFacts.ts";

it.layer(SqliteClient.layerMemory())("068_UsageFacts", (it) => {
  it.effect("creates the usage projection and coverage marker idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)`;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
        )
      `;

      yield* Migration0068;
      const firstCoverage = yield* sql<{ readonly coverageStartedAt: string }>`
        SELECT coverage_started_at AS "coverageStartedAt" FROM projection_usage_metadata
      `;
      yield* Migration0068;
      const secondCoverage = yield* sql<{ readonly coverageStartedAt: string }>`
        SELECT coverage_started_at AS "coverageStartedAt" FROM projection_usage_metadata
      `;

      assert.deepStrictEqual(secondCoverage, firstCoverage);
      assert.equal(firstCoverage.length, 1);
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_turn_usage_facts'
      `;
      assert.equal(
        indexes.some((index) => index.name === "projection_turn_usage_facts_completed_idx"),
        true,
      );
    }),
  );
});
