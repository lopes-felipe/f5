import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0016 from "./016_ProjectionThreadsLastInteractionAt.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("016_ProjectionThreadsLastInteractionAt", (it) => {
  it.effect("backfills last_interaction_at from updated_at for existing rows", () =>
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
          created_at TEXT NOT NULL,
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
          created_at,
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
          '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:05:00.000Z',
          NULL
        )
      `;

      yield* Migration0016;

      const rows = yield* sql<{ readonly lastInteractionAt: string }>`
        SELECT last_interaction_at AS "lastInteractionAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'projection_threads'
          AND name = 'idx_projection_threads_project_last_interaction'
      `;

      assert.deepEqual(rows, [{ lastInteractionAt: "2026-03-01T00:05:00.000Z" }]);
      assert.equal(indexes.length, 1);
    }),
  );
});
