import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent Bridge task board: tasks an F5 user assigns to a connected agent, and
 * their history. Every change advances the workspace revision.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE bot_tasks (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_thread_id TEXT,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'waiting-for-user', 'paused', 'completed', 'failed', 'cancelled'
    )),
    version INTEGER NOT NULL DEFAULT 0,
    execution_epoch INTEGER NOT NULL DEFAULT 0,
    latest_progress TEXT,
    pending_question_id TEXT,
    pending_question TEXT,
    pending_question_at TEXT,
    result TEXT,
    failure TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_contact_at TEXT,
    last_progress_at TEXT
  )`;
  yield* sql`CREATE INDEX bot_tasks_client_status
    ON bot_tasks(client_id, status, created_at, id)`;
  yield* sql`CREATE INDEX bot_tasks_project_status
    ON bot_tasks(project_id, status, created_at, id)`;
  yield* sql`CREATE TABLE bot_task_activities (
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('bot', 'operator')),
    content TEXT,
    operation_id TEXT NOT NULL,
    question_id TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX bot_task_activities_task_sequence
    ON bot_task_activities(task_id, sequence)`;
  yield* sql`CREATE INDEX bot_task_activities_revision ON bot_task_activities(revision)`;
});
