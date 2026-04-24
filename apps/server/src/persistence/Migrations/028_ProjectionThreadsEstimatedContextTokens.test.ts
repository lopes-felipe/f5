import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0028 from "./028_ProjectionThreadsEstimatedContextTokens.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("028_ProjectionThreadsEstimatedContextTokens", (it) => {
  it.effect("adds estimated_context_tokens idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          model TEXT NOT NULL,
          runtime_mode TEXT NOT NULL,
          interaction_mode TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          tasks_json TEXT NOT NULL DEFAULT '[]',
          tasks_turn_id TEXT,
          tasks_updated_at TEXT,
          compaction_json TEXT,
          session_notes_json TEXT,
          thread_references_json TEXT NOT NULL DEFAULT '[]',
          archived_at TEXT,
          created_at TEXT NOT NULL,
          last_interaction_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        )
      `;

      yield* Migration0028;
      yield* Migration0028;

      const rows = yield* sql<{
        readonly name: string;
        readonly type: string;
      }>`
        SELECT
          name,
          type
        FROM pragma_table_info('projection_threads')
        WHERE name = 'estimated_context_tokens'
      `;

      assert.deepEqual(rows, [{ name: "estimated_context_tokens", type: "INTEGER" }]);
    }),
  );
});
