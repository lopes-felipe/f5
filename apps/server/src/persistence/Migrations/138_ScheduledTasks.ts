import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (columns.length && !columns.some((c) => c.name === "scheduled_origin_json"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN scheduled_origin_json TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, definition_json TEXT NOT NULL,
    request_hash TEXT NOT NULL, requested_at TEXT NOT NULL, version INTEGER NOT NULL,
    enabled INTEGER NOT NULL, next_run_at TEXT, deleted_at TEXT, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(next_run_at) WHERE enabled = 1 AND deleted_at IS NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
    scheduled_for TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
    reason TEXT, state_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    command_json TEXT, command_hash TEXT, request_hash TEXT, requested_at TEXT,
    thread_id TEXT UNIQUE, submission_id TEXT UNIQUE, turn_id TEXT,
    owns_execution INTEGER NOT NULL DEFAULT 0, capacity INTEGER NOT NULL DEFAULT 0,
    submission_started INTEGER NOT NULL DEFAULT 0, budget_consumed INTEGER NOT NULL DEFAULT 0,
    canceled INTEGER NOT NULL DEFAULT 0, retry_at TEXT, created_at TEXT NOT NULL,
    finished_at TEXT, last_event_sequence INTEGER NOT NULL DEFAULT 0,
    attention_episode INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_fire_identity ON scheduled_task_runs(task_id, scheduled_for) WHERE trigger != 'manual' AND reason IS NOT 'disabled_interval'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_execution_owner ON scheduled_task_runs(task_id) WHERE owns_execution = 1`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_pending ON scheduled_task_runs(created_at, id) WHERE status = 'pending' AND owns_execution = 1`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_history ON scheduled_task_runs(task_id, created_at DESC, id DESC)`;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_run_submissions (
    submission_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES scheduled_task_runs(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, turn_id TEXT, parent_submission_id TEXT,
    kind TEXT NOT NULL, recovery_decision TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_submission_thread ON scheduled_run_submissions(thread_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_notifications (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
    thread_id TEXT, payload_json TEXT NOT NULL, owner TEXT, lease_until TEXT,
    created_at TEXT NOT NULL, acknowledged_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_notification_delivery ON scheduled_notifications(acknowledged_at, lease_until, created_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_control (
    id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, ready INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, cutover_at TEXT NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO scheduled_control(id,cutover_at) VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const eventTable =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='orchestration_events'`;
  const head = eventTable.length
    ? (yield* sql<{
        n: number;
      }>`SELECT COALESCE(MAX(sequence),0) AS n FROM orchestration_events`)[0]!.n
    : 0;
  const states =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='projection_state'`;
  if (head > 0 && states.length)
    yield* sql`INSERT OR IGNORE INTO projection_state(projector,last_applied_sequence,updated_at) VALUES('scheduledTaskRuns',${head},strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
});
