import { WORKTREE_SETUP_ACTIVITY_KIND } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WORKTREE_SETUP_STARTUP_ROWS_SQL } from "./WorktreeSetup.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("worktree setup startup query", (it) => {
  it.effect("reads worktree-setup activities from their partial index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${WORKTREE_SETUP_STARTUP_ROWS_SQL}`,
      );
      assert.deepEqual(
        plan.map((row) => row.detail),
        [
          "SCAN projection_thread_activities USING INDEX idx_projection_thread_activities_worktree_setup",
        ],
      );
    }),
  );

  it.effect("returns only worktree-setup rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = (id: string, thread: string, kind: string) =>
        sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES (${id}, ${thread}, NULL, 'info', ${kind}, 'summary', ${JSON.stringify({ id })}, '2026-01-01T00:00:00.000Z')`;
      yield* insert("setup-a", "thread-a", WORKTREE_SETUP_ACTIVITY_KIND);
      yield* insert("tool-a", "thread-a", "tool.completed");
      yield* insert("setup-b", "thread-b", WORKTREE_SETUP_ACTIVITY_KIND);
      const rows = yield* sql.unsafe<{ threadId: string; payload: string }>(
        WORKTREE_SETUP_STARTUP_ROWS_SQL,
      );
      assert.deepEqual(rows.map((row) => [row.threadId, row.payload]).toSorted(), [
        ["thread-a", JSON.stringify({ id: "setup-a" })],
        ["thread-b", JSON.stringify({ id: "setup-b" })],
      ]);
    }),
  );
});
