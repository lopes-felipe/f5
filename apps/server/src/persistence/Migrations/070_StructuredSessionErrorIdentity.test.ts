import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0070 from "./070_StructuredSessionErrorIdentity.ts";

it.layer(SqliteClient.layerMemory())("070_StructuredSessionErrorIdentity", (it) => {
  it.effect("adds nullable stable error identity columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          last_error TEXT
        )
      `;

      yield* Migration0070;
      yield* Migration0070;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      const names = columns.map((column) => column.name);
      assert.equal(names.includes("last_error_id"), true);
      assert.equal(names.includes("last_error_occurred_at"), true);
    }),
  );
});
