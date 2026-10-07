import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ensureUsageLimitResumeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, columns] of Object.entries({
    projection_thread_sessions: ["usage_limit_json"],
    provider_turn_deliveries: ["usage_limit_json"],
    next_turn_queue: [
      "schedule_reason",
      "schedule_limit_key",
      "schedule_provider_instance_id",
      "schedule_provider_fingerprint",
    ],
  })) {
    const existing = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM pragma_table_info('${table}')`,
    );
    if (!existing.length) continue;
    for (const column of columns)
      if (!existing.some((entry) => entry.name === column))
        yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  yield* sql`CREATE TABLE IF NOT EXISTS usage_limit_resumes (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    limit_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('scheduled','cancelled','superseded','revoked','gave_up','completed')),
    source TEXT NOT NULL CHECK(source IN ('manual','auto')), auto_eligible_at_failure INTEGER NOT NULL,
    item_id TEXT, not_before TEXT, prev_target TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, limit_key))`;
  yield* sql`CREATE TABLE IF NOT EXISTS usage_limit_resume_streaks (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    auto_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`;
  const queue = yield* sql`SELECT name FROM pragma_table_info('next_turn_queue')`;
  if (queue.length)
    yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS next_turn_queue_one_usage_resume ON next_turn_queue(thread_id) WHERE schedule_reason='usage_limit_reset' AND deleted_at IS NULL`;
});
export default ensureUsageLimitResumeSchema;
