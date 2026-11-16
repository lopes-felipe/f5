import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0127 from "./127_ClearPlanningWorkflowLaneBranches.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("127_ClearPlanningWorkflowLaneBranches", (it) => {
  it.effect("skips databases without the projection tables", () => Migration0127);

  it.effect("skips a thread table without branch columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`
        CREATE TABLE projection_planning_workflows (
          workflow_id TEXT PRIMARY KEY,
          workflow_json TEXT NOT NULL
        )
      `;

      yield* Migration0127;

      yield* sql`DROP TABLE projection_threads`;
      yield* sql`DROP TABLE projection_planning_workflows`;
    }),
  );

  it.effect("clears lane labels only on planning workflow author threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          branch TEXT,
          worktree_path TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_planning_workflows (
          workflow_id TEXT PRIMARY KEY,
          workflow_json TEXT NOT NULL
        )
      `;
      const workflowJson = JSON.stringify({
        branchA: { authorThreadId: "author-a" },
        branchB: { authorThreadId: "author-b" },
      });
      const worktreeWorkflowJson = JSON.stringify({
        branchA: { authorThreadId: "author-worktree" },
        branchB: { authorThreadId: "author-feature" },
      });
      yield* sql`
        INSERT INTO projection_planning_workflows (workflow_id, workflow_json)
        VALUES ('workflow-1', ${workflowJson}), ('workflow-2', ${worktreeWorkflowJson})
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, branch, worktree_path)
        VALUES
          ('author-a', 'a', NULL),
          ('author-b', 'b', NULL),
          ('author-worktree', 'a', '/tmp/worktree'),
          ('author-feature', 'feature/x', NULL),
          ('regular', 'a', NULL)
      `;

      yield* Migration0127;

      const rows = yield* sql<{ readonly threadId: string; readonly branch: string | null }>`
        SELECT thread_id AS "threadId", branch
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepEqual(rows, [
        { threadId: "author-a", branch: null },
        { threadId: "author-b", branch: null },
        { threadId: "author-feature", branch: "feature/x" },
        { threadId: "author-worktree", branch: "a" },
        { threadId: "regular", branch: "a" },
      ]);
    }),
  );
});

for (const columns of ["thread_id TEXT", "thread_id TEXT, branch TEXT"] as const) {
  it.effect(`skips partial legacy thread columns: ${columns}`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE TABLE projection_threads (${columns})`);
      yield* sql`CREATE TABLE projection_planning_workflows (workflow_json TEXT)`;
      yield* Migration0127;
    }).pipe(Effect.provide(SqliteClient.layerMemory())),
  );
}
