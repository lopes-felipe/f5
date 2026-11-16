import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import migration from "./155_BackgroundWorkNativeParentSession.ts";
it.layer(SqliteClient.layerMemory())("155_BackgroundWorkNativeParentSession", (it) => {
  it.effect("adds nullable bounded native identity without changing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_thread_background_work (model TEXT)`;
      yield* sql`INSERT INTO projection_thread_background_work (model) VALUES ('sonnet')`;
      yield* migration;
      yield* migration;
      assert.deepStrictEqual(
        yield* sql`SELECT model,native_parent_session_id FROM projection_thread_background_work`,
        [{ model: "sonnet", native_parent_session_id: null }],
      );
      assert.equal(
        (yield* sql`UPDATE projection_thread_background_work SET native_parent_session_id=${"x".repeat(129)}`.pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
    }),
  );
});
