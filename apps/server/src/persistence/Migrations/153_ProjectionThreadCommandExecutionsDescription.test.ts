import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0153 from "./153_ProjectionThreadCommandExecutionsDescription.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("153_ProjectionThreadCommandExecutionsDescription", (it) => {
  it.effect("adds the description column idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_thread_command_executions (
          command_execution_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          provider_item_id TEXT,
          command TEXT NOT NULL,
          cwd TEXT,
          title TEXT,
          status TEXT NOT NULL,
          detail TEXT,
          output TEXT NOT NULL,
          output_truncated INTEGER NOT NULL,
          exit_code INTEGER,
          started_sequence INTEGER NOT NULL,
          last_updated_sequence INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          updated_at TEXT NOT NULL
        )
      `;

      yield* Migration0153;
      yield* Migration0153;

      const rows = yield* sql<{
        readonly name: string;
        readonly type: string;
      }>`
        SELECT name, type
        FROM pragma_table_info('projection_thread_command_executions')
        WHERE name = 'description'
      `;

      assert.deepEqual(rows, [{ name: "description", type: "TEXT" }]);
    }),
  );
});
