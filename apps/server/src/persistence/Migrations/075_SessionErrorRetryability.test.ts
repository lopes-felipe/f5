import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0075 from "./075_SessionErrorRetryability.ts";

it.layer(SqliteClient.layerMemory())("075_SessionErrorRetryability migration", (it) => {
  it.effect("adds the typed retryability column idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY)`;
      yield* Migration0075;
      yield* Migration0075;
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      assert.equal(columns.filter((column) => column.name === "last_error_retryability").length, 1);
    }),
  );
});
