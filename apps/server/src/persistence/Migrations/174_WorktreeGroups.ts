import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS worktree_groups (
    workspace_path TEXT PRIMARY KEY,
    plan_json TEXT NOT NULL,
    layout_phase TEXT NOT NULL DEFAULT 'pending'
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS project_repository_roots (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY(project_id, path)
  )`;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_pull_requests')`;
  if (columns.length && !columns.some((column) => column.name === "repository_path"))
    yield* sql`ALTER TABLE projection_thread_pull_requests ADD COLUMN repository_path TEXT`;
});
