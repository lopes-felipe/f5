import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Allows `reclassify` upstream runs (SQLite needs a table rebuild to widen the
 * CHECK) and keeps when the weekly feature digest last went out.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE upstream_port_runs_next (
      run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('upstream','legacy','retriage','reclassify')),
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual','continuation')),
      occurrence_due_at TEXT, triage TEXT NOT NULL CHECK (triage IN ('llm','rules-only')),
      started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','succeeded','partial','failed','interrupted')),
      failure_kind TEXT, target_sha TEXT, commit_count INTEGER NOT NULL DEFAULT 0,
      inbox_count INTEGER NOT NULL DEFAULT 0, auto_decided_count INTEGER NOT NULL DEFAULT 0,
      remaining_count INTEGER NOT NULL DEFAULT 0, llm_calls INTEGER NOT NULL DEFAULT 0, error_message TEXT)`;
      yield* sql`INSERT INTO upstream_port_runs_next (
      run_id,project_id,kind,trigger,occurrence_due_at,triage,started_at,finished_at,status,
      failure_kind,target_sha,commit_count,inbox_count,auto_decided_count,remaining_count,llm_calls,error_message)
      SELECT run_id,project_id,kind,trigger,occurrence_due_at,triage,started_at,finished_at,status,
      failure_kind,target_sha,commit_count,inbox_count,auto_decided_count,remaining_count,llm_calls,error_message
      FROM upstream_port_runs`;
      yield* sql`DROP TABLE upstream_port_runs`;
      yield* sql`PRAGMA legacy_alter_table = ON`;
      yield* sql`ALTER TABLE upstream_port_runs_next RENAME TO upstream_port_runs`.pipe(
        Effect.ensuring(sql`PRAGMA legacy_alter_table = OFF`.pipe(Effect.ignore)),
      );
      yield* sql`CREATE INDEX upstream_port_runs_project ON upstream_port_runs(project_id,started_at)`;
      yield* sql`CREATE UNIQUE INDEX upstream_port_runs_one_running ON upstream_port_runs(project_id) WHERE status = 'running'`;
      yield* sql`CREATE TABLE upstream_budget_state (
      project_id TEXT PRIMARY KEY, last_digest_at TEXT)`;
    }),
  );
});
