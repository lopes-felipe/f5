import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS worktree_preparations (
    operation_id TEXT PRIMARY KEY,
    repository_identity TEXT NOT NULL,
    project_identity TEXT NOT NULL,
    owner TEXT NOT NULL,
    requested_base TEXT NOT NULL,
    base_oid TEXT,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    naming_intent TEXT NOT NULL,
    setup_identity TEXT,
    run_setup_script INTEGER NOT NULL,
    phase TEXT NOT NULL,
    created_checkout INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_worktree_preparations_path
    ON worktree_preparations(path, created_at DESC)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_preparations_reserved_branch
    ON worktree_preparations(repository_identity, branch)
    WHERE phase IN ('allocated', 'checkout_created', 'setup_running', 'setup_failed', 'setup_indeterminate')`;
  yield* sql`CREATE TABLE IF NOT EXISTS worktree_setup_ordering (
    thread_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL DEFAULT 0
  )`;
});
