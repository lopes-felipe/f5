import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Planning workflows used to record their author lane ("a"/"b") as the
 * author thread's Git branch. Authors run in the project checkout, so the
 * lane made the send-time branch check report drift on every follow-up.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('projection_threads', 'projection_planning_workflows')
  `;

  if (tables.length < 2) {
    return;
  }

  // Repair-test and legacy databases can contain only part of the projection schema.
  const threadColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  const workflowColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_planning_workflows')`;
  if (
    !["thread_id", "branch", "worktree_path"].every((name) =>
      threadColumns.some((column) => column.name === name),
    ) ||
    !workflowColumns.some((column) => column.name === "workflow_json")
  )
    return;

  yield* sql`
    UPDATE projection_threads
    SET branch = NULL
    WHERE branch IN ('a', 'b')
      AND worktree_path IS NULL
      AND thread_id IN (
        SELECT json_extract(workflow_json, '$.branchA.authorThreadId')
        FROM projection_planning_workflows
        UNION
        SELECT json_extract(workflow_json, '$.branchB.authorThreadId')
        FROM projection_planning_workflows
      )
  `;
});
