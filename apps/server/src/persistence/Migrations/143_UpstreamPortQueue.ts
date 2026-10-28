import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Local queue and outcome ownership; ledger writes still go through the publisher. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE upstream_ledger_ops_next (
      op_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('interval','legacy','decision','suggestion')),
      target TEXT NOT NULL, payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('recorded','merged','superseded','discarded')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, seq))`;
      yield* sql`INSERT INTO upstream_ledger_ops_next
      (op_id,project_id,seq,kind,target,payload_json,state,created_at,updated_at)
      SELECT op_id,project_id,seq,kind,target,payload_json,state,created_at,updated_at FROM upstream_ledger_ops`;
      yield* sql`CREATE TABLE upstream_port_runs_next (
      run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('upstream','legacy','retriage')),
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
      yield* sql`DROP TABLE upstream_ledger_ops`;
      yield* sql`DROP TABLE upstream_port_runs`;
      yield* sql`PRAGMA legacy_alter_table = ON`;
      yield* Effect.gen(function* () {
        yield* sql`ALTER TABLE upstream_ledger_ops_next RENAME TO upstream_ledger_ops`;
        yield* sql`ALTER TABLE upstream_port_runs_next RENAME TO upstream_port_runs`;
      }).pipe(Effect.ensuring(sql`PRAGMA legacy_alter_table = OFF`.pipe(Effect.ignore)));
      yield* sql`CREATE INDEX upstream_ledger_ops_open ON upstream_ledger_ops(project_id,state,seq)`;
      yield* sql`CREATE INDEX upstream_ledger_ops_target ON upstream_ledger_ops(project_id,kind,target,seq)`;
      yield* sql`CREATE INDEX upstream_port_runs_project ON upstream_port_runs(project_id,started_at)`;
      yield* sql`CREATE UNIQUE INDEX upstream_port_runs_one_running ON upstream_port_runs(project_id) WHERE status = 'running'`;
      yield* sql`CREATE TABLE upstream_port_queue (
      project_id TEXT NOT NULL, entry_id TEXT NOT NULL, position INTEGER NOT NULL,
      topic_ids_json TEXT NOT NULL, topic_epochs_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL, runtime_mode TEXT NOT NULL, request_id TEXT NOT NULL,
      file_keys_json TEXT NOT NULL DEFAULT '[]', ignore_conflicts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('queued','started','finished','dropped')),
      thread_id TEXT, result TEXT, topic_results_json TEXT, reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      PRIMARY KEY(project_id,entry_id))`;
      yield* sql`CREATE INDEX upstream_port_queue_status ON upstream_port_queue(project_id,status,position)`;
      yield* sql`CREATE TABLE upstream_port_queue_requests (
      project_id TEXT NOT NULL, client_request_id TEXT NOT NULL, args_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,client_request_id))`;
      yield* sql`CREATE TABLE upstream_port_queue_state (
      project_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, paused_reason TEXT,
      hold_kind TEXT, hold_message TEXT, hold_until TEXT, error_streak INTEGER NOT NULL DEFAULT 0,
      queue_version INTEGER NOT NULL DEFAULT 0)`;
      yield* sql`CREATE TABLE upstream_port_outcome_checks (
      project_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT,
      result TEXT NOT NULL CHECK (result IN ('preexisting','recorded','no-outcome','not-eligible','failed')),
      detail TEXT, checked_at TEXT NOT NULL, PRIMARY KEY(project_id,thread_id))`;
      yield* sql`INSERT INTO upstream_port_outcome_checks(project_id,thread_id,result,checked_at)
      SELECT DISTINCT project_id,thread_id,'preexisting',strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM upstream_port_links WHERE state = 'active'`;
    }),
  );
});
