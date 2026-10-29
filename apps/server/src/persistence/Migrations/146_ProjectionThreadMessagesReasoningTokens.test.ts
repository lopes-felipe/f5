import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0146 from "./146_ProjectionThreadMessagesReasoningTokens.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("146_ProjectionThreadMessagesReasoningTokens", (it) => {
  it.effect("adds reasoning token columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_thread_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          reasoning_text TEXT,
          is_streaming INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;

      yield* Migration0146;
      yield* Migration0146;

      const rows = yield* sql<{
        readonly name: string;
        readonly type: string;
      }>`
        SELECT name, type
        FROM pragma_table_info('projection_thread_messages')
        WHERE name LIKE 'reasoning_tokens%'
        ORDER BY name
      `;

      assert.deepEqual(rows, [
        { name: "reasoning_tokens", type: "INTEGER" },
        { name: "reasoning_tokens_estimated", type: "INTEGER" },
      ]);
    }),
  );
});
