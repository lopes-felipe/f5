import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0030 from "./030_ProjectionModelContextWindowTokens.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("030_ProjectionModelContextWindowTokens", (it) => {
  it.effect("adds model_context_window_tokens columns idempotently", () =>
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
          estimated_context_tokens INTEGER,
          session_notes_json TEXT,
          thread_references_json TEXT NOT NULL DEFAULT '[]',
          archived_at TEXT,
          created_at TEXT NOT NULL,
          last_interaction_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        )
      `;

      yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          provider_name TEXT,
          runtime_mode TEXT NOT NULL,
          active_turn_id TEXT,
          last_error TEXT,
          estimated_context_tokens INTEGER,
          token_usage_source TEXT,
          updated_at TEXT NOT NULL
        )
      `;

      yield* Migration0030;
      yield* Migration0030;

      const rows = yield* sql<{
        readonly tableName: string;
        readonly name: string;
        readonly type: string;
      }>`
        SELECT 'projection_thread_sessions' AS "tableName", name, type
        FROM pragma_table_info('projection_thread_sessions')
        WHERE name = 'model_context_window_tokens'
        UNION ALL
        SELECT 'projection_threads' AS "tableName", name, type
        FROM pragma_table_info('projection_threads')
        WHERE name = 'model_context_window_tokens'
        ORDER BY "tableName" ASC
      `;

      assert.deepEqual(rows, [
        {
          tableName: "projection_thread_sessions",
          name: "model_context_window_tokens",
          type: "INTEGER",
        },
        { tableName: "projection_threads", name: "model_context_window_tokens", type: "INTEGER" },
      ]);
    }),
  );
});
