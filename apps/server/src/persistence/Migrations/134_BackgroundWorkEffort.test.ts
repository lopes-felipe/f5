import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0129 from "./134_BackgroundWorkEffort.ts";
it.layer(SqliteClient.layerMemory())("134_BackgroundWorkEffort", (it) => {
  it.effect("preserves old metadata and adds a nullable bounded effort column idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_thread_background_work (model TEXT)`;
      yield* sql`INSERT INTO projection_thread_background_work (model) VALUES ('claude-sonnet-4-6')`;
      yield* Migration0129;
      yield* Migration0129;
      const rows = yield* sql`SELECT model,effort FROM projection_thread_background_work`;
      assert.deepStrictEqual(rows, [{ model: "claude-sonnet-4-6", effort: null }]);
      const rejected =
        yield* sql`UPDATE projection_thread_background_work SET effort=${"x".repeat(65)}`.pipe(
          Effect.result,
        );
      assert.equal(rejected._tag, "Failure");
      yield* sql`DROP TABLE projection_thread_background_work`;
      yield* Migration0129;
    }),
  );
});
