import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0029 from "./029_ProjectionThreadSessionsTokenUsage.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("029_ProjectionThreadSessionsTokenUsage", (it) => {
  it.effect("adds token usage columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          provider_name TEXT,
          runtime_mode TEXT NOT NULL,
          active_turn_id TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        )
      `;

      yield* Migration0029;
      yield* Migration0029;

      const rows = yield* sql<{
        readonly name: string;
        readonly type: string;
      }>`
        SELECT
          name,
          type
        FROM pragma_table_info('projection_thread_sessions')
        WHERE name IN ('estimated_context_tokens', 'token_usage_source')
        ORDER BY name ASC
      `;

      assert.deepEqual(rows, [
        { name: "estimated_context_tokens", type: "INTEGER" },
        { name: "token_usage_source", type: "TEXT" },
      ]);
    }),
  );
});
