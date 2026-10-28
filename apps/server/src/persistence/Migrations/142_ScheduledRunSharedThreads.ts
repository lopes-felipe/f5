import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Thread-bound scheduled tasks send every run into the same conversation, so
 * `scheduled_task_runs.thread_id` can no longer be unique. SQLite cannot drop
 * a column constraint, so the table is rebuilt under its own name.
 *
 * Foreign keys stay on: dropping the runs table would cascade-delete
 * `scheduled_run_submissions`, so that table is backed up, dropped first and
 * restored afterwards. The rename runs with `legacy_alter_table` on for the
 * same reason as migration 106. Older builds quarantine bound tasks because
 * they cannot decode the thread workspace; unbound tasks are unaffected.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs'`;
  if (!table.length) return;
  const uniqueThread = yield* sql<{ name: string }>`
    SELECT l.name FROM pragma_index_list('scheduled_task_runs') l
    WHERE l."unique" = 1 AND (SELECT COUNT(*) FROM pragma_index_info(l.name)) = 1
    AND EXISTS (SELECT 1 FROM pragma_index_info(l.name) i WHERE i.name = 'thread_id')`;
  if (!uniqueThread.length) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE scheduled_task_runs_next (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
        scheduled_for TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
        reason TEXT, state_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        command_json TEXT, command_hash TEXT, request_hash TEXT, requested_at TEXT,
        thread_id TEXT, submission_id TEXT UNIQUE, turn_id TEXT,
        owns_execution INTEGER NOT NULL DEFAULT 0, capacity INTEGER NOT NULL DEFAULT 0,
        submission_started INTEGER NOT NULL DEFAULT 0, budget_consumed INTEGER NOT NULL DEFAULT 0,
        canceled INTEGER NOT NULL DEFAULT 0, retry_at TEXT, created_at TEXT NOT NULL,
        finished_at TEXT, last_event_sequence INTEGER NOT NULL DEFAULT 0,
        attention_episode INTEGER NOT NULL DEFAULT 0
      )`;
      // Named columns: the source layout lives in migration 138.
      yield* sql`INSERT INTO scheduled_task_runs_next (
          id, task_id, scheduled_for, trigger, status, reason, state_json, snapshot_json,
          command_json, command_hash, request_hash, requested_at, thread_id, submission_id,
          turn_id, owns_execution, capacity, submission_started, budget_consumed, canceled,
          retry_at, created_at, finished_at, last_event_sequence, attention_episode
        ) SELECT
          id, task_id, scheduled_for, trigger, status, reason, state_json, snapshot_json,
          command_json, command_hash, request_hash, requested_at, thread_id, submission_id,
          turn_id, owns_execution, capacity, submission_started, budget_consumed, canceled,
          retry_at, created_at, finished_at, last_event_sequence, attention_episode
        FROM scheduled_task_runs`;
      yield* sql`CREATE TEMP TABLE scheduled_run_submissions_backup AS
        SELECT submission_id, run_id, thread_id, message_id, turn_id, parent_submission_id,
          kind, recovery_decision
        FROM scheduled_run_submissions ORDER BY rowid`;
      yield* sql`DROP TABLE scheduled_run_submissions`;
      yield* sql`DROP TABLE scheduled_task_runs`;
      yield* sql`PRAGMA legacy_alter_table = ON`;
      yield* sql`ALTER TABLE scheduled_task_runs_next RENAME TO scheduled_task_runs`.pipe(
        Effect.ensuring(sql`PRAGMA legacy_alter_table = OFF`.pipe(Effect.ignore)),
      );
      yield* sql`CREATE TABLE scheduled_run_submissions (
        submission_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES scheduled_task_runs(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, turn_id TEXT, parent_submission_id TEXT,
        kind TEXT NOT NULL, recovery_decision TEXT
      )`;
      yield* sql`INSERT INTO scheduled_run_submissions (
          submission_id, run_id, thread_id, message_id, turn_id, parent_submission_id,
          kind, recovery_decision
        ) SELECT
          submission_id, run_id, thread_id, message_id, turn_id, parent_submission_id,
          kind, recovery_decision
        FROM scheduled_run_submissions_backup ORDER BY rowid`;
      yield* sql`DROP TABLE scheduled_run_submissions_backup`;
      yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_fire_identity ON scheduled_task_runs(task_id, scheduled_for) WHERE trigger != 'manual' AND reason IS NOT 'disabled_interval'`;
      yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_execution_owner ON scheduled_task_runs(task_id) WHERE owns_execution = 1`;
      yield* sql`CREATE INDEX IF NOT EXISTS scheduled_pending ON scheduled_task_runs(created_at, id) WHERE status = 'pending' AND owns_execution = 1`;
      yield* sql`CREATE INDEX IF NOT EXISTS scheduled_history ON scheduled_task_runs(task_id, created_at DESC, id DESC)`;
      yield* sql`CREATE INDEX IF NOT EXISTS scheduled_submission_thread ON scheduled_run_submissions(thread_id)`;
      yield* sql`CREATE INDEX IF NOT EXISTS scheduled_submission_parent
        ON scheduled_run_submissions(run_id,parent_submission_id,recovery_decision)`;
      yield* sql`CREATE INDEX IF NOT EXISTS scheduled_run_thread ON scheduled_task_runs(thread_id)`;
    }),
  );
});
