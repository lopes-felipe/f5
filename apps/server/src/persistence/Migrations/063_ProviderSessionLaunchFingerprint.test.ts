import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0063 from "./063_ProviderSessionLaunchFingerprint.ts";

it.layer(SqliteClient.layerMemory())("063_ProviderSessionLaunchFingerprint", (it) => {
  it.effect("adds the nullable launch fingerprint idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE provider_session_runtime (
          thread_id TEXT PRIMARY KEY,
          provider_name TEXT NOT NULL
        )
      `;
      yield* Migration0063;
      yield* Migration0063;

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        SELECT name, "notnull"
        FROM pragma_table_info('provider_session_runtime')
        WHERE name = 'launch_fingerprint'
      `;
      assert.deepStrictEqual(columns, [{ name: "launch_fingerprint", notnull: 0 }]);
    }),
  );
});
