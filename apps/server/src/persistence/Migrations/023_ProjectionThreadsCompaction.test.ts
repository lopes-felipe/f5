import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0023 from "./023_ProjectionThreadsCompaction.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("023_ProjectionThreadsCompaction", (it) => {
  it.effect("adds compaction_json with a null default for existing rows", () =>
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
          archived_at TEXT,
          created_at TEXT NOT NULL,
          last_interaction_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          tasks_json,
          archived_at,
          created_at,
          last_interaction_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          'gpt-5-codex',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '[]',
          NULL,
          '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:05:00.000Z',
          '2026-03-01T00:05:00.000Z',
          NULL
        )
      `;

      yield* Migration0023;

      const rows = yield* sql<{ readonly compactionJson: string | null }>`
        SELECT compaction_json AS "compactionJson"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;

      assert.deepEqual(rows, [{ compactionJson: null }]);
    }),
  );
});
