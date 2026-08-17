import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases that advanced past the base projection migration while
 * missing core read-model tables or columns. When a table shape is repaired,
 * the matching projector cursor is deleted so bootstrap replays event history
 * instead of leaving a newly-created table empty.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectorsToReset = new Set<string>();

  const tableExists = (tableName: string) =>
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ${tableName}
      `;

      return tables.length > 0;
    });

  const readColumnNames = (tableName: string) =>
    Effect.gen(function* () {
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_table_info(${tableName})
      `;

      return new Set(columns.map((column) => column.name));
    });

  const resetProjectors = (...projectors: ReadonlyArray<string>) => {
    for (const projector of projectors) {
      projectorsToReset.add(projector);
    }
  };

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const hasProjectionThreads = yield* tableExists("projection_threads");
  if (!hasProjectionThreads) {
    resetProjectors("projection.threads");
  }

  // Keep in sync with 005_Projections and later projection_threads migrations.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      model_selection_json TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      tasks_json TEXT NOT NULL DEFAULT '[]',
      tasks_turn_id TEXT,
      tasks_updated_at TEXT,
      compaction_json TEXT,
      estimated_context_tokens INTEGER,
      model_context_window_tokens INTEGER,
      session_notes_json TEXT,
      thread_references_json TEXT NOT NULL DEFAULT '[]',
      archived_at TEXT,
      pinned_at TEXT,
      pin_order_key INTEGER,
      snoozed_until TEXT,
      snoozed_at TEXT,
      title_source TEXT NOT NULL DEFAULT 'legacy',
      title_revision INTEGER NOT NULL DEFAULT 0,
      title_updated_at TEXT,
      title_regeneration_request_id TEXT,
      title_regeneration_started_at TEXT,
      created_at TEXT NOT NULL,
      last_interaction_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  // Defaults on ALTER paths are repair placeholders required by SQLite for
  // populated tables; resetting the projector cursor lets replay overwrite them.
  const threadColumns = yield* readColumnNames("projection_threads");
  if (!threadColumns.has("project_id")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN project_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!threadColumns.has("title")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!threadColumns.has("model")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5-codex'
    `;
  }

  if (!threadColumns.has("model_selection_json")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model_selection_json TEXT
    `;
  }

  if (!threadColumns.has("runtime_mode")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    `;
  }

  if (!threadColumns.has("interaction_mode")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
    `;
  }

  if (!threadColumns.has("branch")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN branch TEXT
    `;
  }

  if (!threadColumns.has("worktree_path")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN worktree_path TEXT
    `;
  }

  if (!threadColumns.has("latest_turn_id")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_turn_id TEXT
    `;
  }

  if (!threadColumns.has("last_interaction_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_interaction_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!threadColumns.has("archived_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_at TEXT
    `;
  }

  if (!threadColumns.has("pinned_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_at TEXT
    `;
  }

  if (!threadColumns.has("pin_order_key")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pin_order_key INTEGER
    `;
  }

  if (!threadColumns.has("snoozed_until")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_until TEXT
    `;
  }

  if (!threadColumns.has("snoozed_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_at TEXT
    `;
  }

  if (!threadColumns.has("title_source")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'
    `;
  }

  if (!threadColumns.has("title_revision")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!threadColumns.has("title_updated_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_updated_at TEXT
    `;
  }

  if (!threadColumns.has("title_regeneration_request_id")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_request_id TEXT
    `;
  }

  if (!threadColumns.has("title_regeneration_started_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_started_at TEXT
    `;
  }

  if (!threadColumns.has("created_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!threadColumns.has("updated_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!threadColumns.has("deleted_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN deleted_at TEXT
    `;
  }

  if (!threadColumns.has("tasks_json")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tasks_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  if (!threadColumns.has("tasks_turn_id")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tasks_turn_id TEXT
    `;
  }

  if (!threadColumns.has("tasks_updated_at")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tasks_updated_at TEXT
    `;
  }

  if (!threadColumns.has("compaction_json")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN compaction_json TEXT
    `;
  }

  if (!threadColumns.has("estimated_context_tokens")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN estimated_context_tokens INTEGER
    `;
  }

  if (!threadColumns.has("model_context_window_tokens")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model_context_window_tokens INTEGER
    `;
  }

  if (!threadColumns.has("session_notes_json")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN session_notes_json TEXT
    `;
  }

  if (!threadColumns.has("thread_references_json")) {
    resetProjectors("projection.threads");
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN thread_references_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET thread_references_json = '[]'
    WHERE thread_references_json IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
    ON projection_threads(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_last_interaction
    ON projection_threads(project_id, last_interaction_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_last_interaction
    ON projection_threads(project_id, archived_at, last_interaction_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_pin_order_idx
    ON projection_threads(pin_order_key)
    WHERE pin_order_key IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_snoozed_until_idx
    ON projection_threads(snoozed_until)
    WHERE snoozed_until IS NOT NULL
  `;

  const hasProjectionThreadMessages = yield* tableExists("projection_thread_messages");
  if (!hasProjectionThreadMessages) {
    resetProjectors("projection.thread-messages");
  }

  // Keep in sync with 005_Projections and later projection_thread_messages migrations.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      reasoning_text TEXT,
      skill_call_json TEXT,
      attachments_json TEXT,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const messageColumns = yield* readColumnNames("projection_thread_messages");
  if (!messageColumns.has("thread_id")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!messageColumns.has("turn_id")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN turn_id TEXT
    `;
  }

  if (!messageColumns.has("role")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
    `;
  }

  if (!messageColumns.has("text")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN text TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!messageColumns.has("reasoning_text")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN reasoning_text TEXT
    `;
  }

  if (!messageColumns.has("skill_call_json")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN skill_call_json TEXT
    `;
  }

  if (!messageColumns.has("attachments_json")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN attachments_json TEXT
    `;
  }

  if (!messageColumns.has("is_streaming")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN is_streaming INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!messageColumns.has("created_at")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!messageColumns.has("updated_at")) {
    resetProjectors("projection.thread-messages");
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created
    ON projection_thread_messages(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_message_id
    ON projection_thread_messages(thread_id, created_at, message_id)
  `;

  const hasProjectionThreadActivities = yield* tableExists("projection_thread_activities");
  if (!hasProjectionThreadActivities) {
    resetProjectors("projection.thread-activities");
  }

  // Keep in sync with 005_Projections and 008_ProjectionThreadActivitySequence.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sequence INTEGER,
      created_at TEXT NOT NULL
    )
  `;

  const activityColumns = yield* readColumnNames("projection_thread_activities");
  if (!activityColumns.has("thread_id")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!activityColumns.has("turn_id")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN turn_id TEXT
    `;
  }

  if (!activityColumns.has("tone")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN tone TEXT NOT NULL DEFAULT 'info'
    `;
  }

  if (!activityColumns.has("kind")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'status'
    `;
  }

  if (!activityColumns.has("summary")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN summary TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!activityColumns.has("payload_json")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'
    `;
  }

  if (!activityColumns.has("sequence")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN sequence INTEGER
    `;
  }

  if (!activityColumns.has("created_at")) {
    resetProjectors("projection.thread-activities");
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_created
    ON projection_thread_activities(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence
    ON projection_thread_activities(thread_id, sequence)
  `;

  const hasProjectionThreadSessions = yield* tableExists("projection_thread_sessions");
  if (!hasProjectionThreadSessions) {
    resetProjectors("projection.thread-sessions");
  }

  // Keep in sync with 005_Projections and later projection_thread_sessions migrations.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_name TEXT,
      provider_instance_id TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      active_turn_id TEXT,
      last_error TEXT,
      last_error_id TEXT,
      last_error_occurred_at TEXT,
      estimated_context_tokens INTEGER,
      model_context_window_tokens INTEGER,
      token_usage_source TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  const sessionColumns = yield* readColumnNames("projection_thread_sessions");
  if (!sessionColumns.has("status")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'
    `;
  }

  if (!sessionColumns.has("provider_name")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_name TEXT
    `;
  }

  if (!sessionColumns.has("provider_instance_id")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  if (!sessionColumns.has("provider_session_id")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_session_id TEXT
    `;
  }

  if (!sessionColumns.has("provider_thread_id")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_thread_id TEXT
    `;
  }

  if (!sessionColumns.has("runtime_mode")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    `;
  }

  if (!sessionColumns.has("active_turn_id")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN active_turn_id TEXT
    `;
  }

  if (!sessionColumns.has("last_error")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error TEXT
    `;
  }

  if (!sessionColumns.has("last_error_id")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_id TEXT
    `;
  }

  if (!sessionColumns.has("last_error_occurred_at")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_occurred_at TEXT
    `;
  }

  if (!sessionColumns.has("estimated_context_tokens")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN estimated_context_tokens INTEGER
    `;
  }

  if (!sessionColumns.has("model_context_window_tokens")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN model_context_window_tokens INTEGER
    `;
  }

  if (!sessionColumns.has("token_usage_source")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN token_usage_source TEXT
    `;
  }

  if (!sessionColumns.has("updated_at")) {
    resetProjectors("projection.thread-sessions");
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_instance_id = provider_name
    WHERE provider_instance_id IS NULL
      AND provider_name IS NOT NULL
      AND length(trim(provider_name)) > 0
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_session
    ON projection_thread_sessions(provider_session_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_instance
    ON projection_thread_sessions(provider_instance_id)
  `;

  const hasProjectionThreadFileChanges = yield* tableExists("projection_thread_file_changes");
  if (!hasProjectionThreadFileChanges) {
    resetProjectors("projection.thread-file-changes");
  }

  // Keep in sync with 035_ProjectionThreadFileChanges.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_file_changes (
      file_change_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_item_id TEXT,
      title TEXT,
      detail TEXT,
      status TEXT NOT NULL,
      changed_files TEXT NOT NULL,
      patch TEXT NOT NULL,
      started_sequence INTEGER NOT NULL,
      last_updated_sequence INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  const fileChangeColumns = yield* readColumnNames("projection_thread_file_changes");
  if (!fileChangeColumns.has("thread_id")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!fileChangeColumns.has("turn_id")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN turn_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!fileChangeColumns.has("provider_item_id")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN provider_item_id TEXT
    `;
  }

  if (!fileChangeColumns.has("title")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN title TEXT
    `;
  }

  if (!fileChangeColumns.has("detail")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN detail TEXT
    `;
  }

  if (!fileChangeColumns.has("status")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN status TEXT NOT NULL DEFAULT 'interrupted'
    `;
  }

  if (!fileChangeColumns.has("changed_files")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN changed_files TEXT NOT NULL DEFAULT '[]'
    `;
  }

  if (!fileChangeColumns.has("patch")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN patch TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!fileChangeColumns.has("started_sequence")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN started_sequence INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!fileChangeColumns.has("last_updated_sequence")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN last_updated_sequence INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!fileChangeColumns.has("started_at")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN started_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!fileChangeColumns.has("completed_at")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN completed_at TEXT
    `;
  }

  if (!fileChangeColumns.has("updated_at")) {
    resetProjectors("projection.thread-file-changes");
    yield* sql`
      ALTER TABLE projection_thread_file_changes
      ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_file_changes_thread_started
    ON projection_thread_file_changes(thread_id, started_at, started_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_file_changes_thread_last_updated
    ON projection_thread_file_changes(thread_id, last_updated_sequence)
  `;

  const hasProjectionTurns = yield* tableExists("projection_turns");
  if (!hasProjectionTurns) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
  }

  // Keep in sync with 005_Projections, 015_ProjectionTurnsSourceProposedPlan,
  // and 058_TurnDeliveryDurability.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      pending_message_id TEXT,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      processing_quiesced_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL,
      UNIQUE (thread_id, turn_id),
      UNIQUE (thread_id, checkpoint_turn_count)
    )
  `;

  const turnColumns = yield* readColumnNames("projection_turns");
  if (!turnColumns.has("thread_id")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!turnColumns.has("turn_id")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN turn_id TEXT
    `;
  }

  if (!turnColumns.has("pending_message_id")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN pending_message_id TEXT
    `;
  }

  if (!turnColumns.has("source_proposed_plan_thread_id")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN source_proposed_plan_thread_id TEXT
    `;
  }

  if (!turnColumns.has("source_proposed_plan_id")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN source_proposed_plan_id TEXT
    `;
  }

  if (!turnColumns.has("assistant_message_id")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN assistant_message_id TEXT
    `;
  }

  if (!turnColumns.has("state")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
    `;
  }

  if (!turnColumns.has("requested_at")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN requested_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!turnColumns.has("started_at")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN started_at TEXT
    `;
  }

  if (!turnColumns.has("completed_at")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN completed_at TEXT
    `;
  }

  if (!turnColumns.has("processing_quiesced_at")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN processing_quiesced_at TEXT
    `;
  }

  if (!turnColumns.has("checkpoint_turn_count")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN checkpoint_turn_count INTEGER
    `;
  }

  if (!turnColumns.has("checkpoint_ref")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN checkpoint_ref TEXT
    `;
  }

  if (!turnColumns.has("checkpoint_status")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN checkpoint_status TEXT
    `;
  }

  if (!turnColumns.has("checkpoint_files_json")) {
    resetProjectors("projection.thread-turns", "projection.checkpoints");
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN checkpoint_files_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_requested
    ON projection_turns(thread_id, requested_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_checkpoint_completed
    ON projection_turns(thread_id, checkpoint_turn_count, completed_at)
  `;

  const hasProjectionPendingApprovals = yield* tableExists("projection_pending_approvals");
  if (!hasProjectionPendingApprovals) {
    resetProjectors("projection.pending-approvals");
  }

  // Keep in sync with 005_Projections.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_approvals (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  const pendingApprovalColumns = yield* readColumnNames("projection_pending_approvals");
  if (!pendingApprovalColumns.has("thread_id")) {
    resetProjectors("projection.pending-approvals");
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''
    `;
  }

  if (!pendingApprovalColumns.has("turn_id")) {
    resetProjectors("projection.pending-approvals");
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN turn_id TEXT
    `;
  }

  if (!pendingApprovalColumns.has("status")) {
    resetProjectors("projection.pending-approvals");
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
    `;
  }

  if (!pendingApprovalColumns.has("decision")) {
    resetProjectors("projection.pending-approvals");
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN decision TEXT
    `;
  }

  if (!pendingApprovalColumns.has("created_at")) {
    resetProjectors("projection.pending-approvals");
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    `;
  }

  if (!pendingApprovalColumns.has("resolved_at")) {
    resetProjectors("projection.pending-approvals");
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN resolved_at TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_thread_status
    ON projection_pending_approvals(thread_id, status)
  `;

  if (projectorsToReset.size > 0) {
    yield* Effect.forEach(
      Array.from(projectorsToReset),
      (projector) => sql`DELETE FROM projection_state WHERE projector = ${projector}`,
      { discard: true },
    );
  }
});
