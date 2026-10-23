import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Upstream ports: the local operation log that the rolling ledger PR
 * publishes, run and schedule bookkeeping, and crash-safe port admission.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE upstream_ledger_ops (
    op_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('interval', 'legacy', 'decision')),
    target TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('recorded', 'merged', 'superseded', 'discarded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, seq)
  )`;
  yield* sql`CREATE INDEX upstream_ledger_ops_open
    ON upstream_ledger_ops(project_id, state, seq)`;
  yield* sql`CREATE TABLE upstream_ledger_publication (
    project_id TEXT PRIMARY KEY,
    branch TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    pr_state TEXT,
    last_commit_sha TEXT,
    last_pushed_sha TEXT,
    phase TEXT NOT NULL DEFAULT 'idle'
      CHECK (phase IN ('idle', 'committing', 'pushing', 'opening-pr')),
    paused_reason TEXT CHECK (paused_reason IS NULL OR paused_reason IN
      ('closed-pr', 'conflict', 'signing', 'auth', 'push-rejected', 'writer-lost')),
    last_error TEXT,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    links_version INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE upstream_port_runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upstream', 'legacy')),
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'continuation')),
    occurrence_due_at TEXT,
    triage TEXT NOT NULL CHECK (triage IN ('llm', 'rules-only')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
    failure_kind TEXT,
    target_sha TEXT,
    commit_count INTEGER NOT NULL DEFAULT 0,
    inbox_count INTEGER NOT NULL DEFAULT 0,
    auto_decided_count INTEGER NOT NULL DEFAULT 0,
    remaining_count INTEGER NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
  )`;
  yield* sql`CREATE INDEX upstream_port_runs_project
    ON upstream_port_runs(project_id, started_at)`;
  // At most one running triage run per project, even if two starts race.
  yield* sql`CREATE UNIQUE INDEX upstream_port_runs_one_running
    ON upstream_port_runs(project_id) WHERE status = 'running'`;
  yield* sql`CREATE TABLE upstream_port_occurrences (
    project_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'superseded')),
    attempts INTEGER NOT NULL DEFAULT 0,
    continuations INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_run_id TEXT,
    last_error TEXT,
    PRIMARY KEY (project_id, due_at)
  )`;
  yield* sql`CREATE TABLE upstream_port_requests (
    project_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, client_request_id)
  )`;
  yield* sql`CREATE TABLE upstream_port_groups (
    project_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    topic_ids_json TEXT NOT NULL,
    command_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'rejected')),
    reason TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, client_request_id, group_index)
  )`;
  yield* sql`CREATE INDEX upstream_port_groups_pending
    ON upstream_port_groups(status) WHERE status = 'pending'`;
  yield* sql`CREATE TABLE upstream_port_links (
    project_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'unlinked')),
    PRIMARY KEY (project_id, topic_id, epoch, thread_id)
  )`;
});
