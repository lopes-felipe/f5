import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0048 from "./048_ProjectionCoreSchemaRepair.ts";

const layer = it.layer(SqliteClient.layerMemory());

const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`PRAGMA foreign_keys = OFF`;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `;

  yield* Effect.forEach(tables, ({ name }) => sql`DROP TABLE IF EXISTS ${sql(name)}`, {
    discard: true,
  });

  yield* sql`PRAGMA foreign_keys = ON`;
});

const seedMigrationTableAt = (migrationId: number, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )
    `;

    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migrationId}, ${name})
    `;
  });

const coreRepairTables = [
  "projection_state",
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_sessions",
  "projection_thread_file_changes",
  "projection_turns",
  "projection_pending_approvals",
] as const;

const readCoreRepairSchemaSummary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columnGroups = yield* Effect.forEach(
    coreRepairTables,
    (tableName) =>
      sql<{
        readonly tableName: string;
        readonly name: string;
        readonly type: string;
        readonly notNull: number;
        readonly defaultValue: string | null;
        readonly primaryKey: number;
      }>`
        SELECT
          ${tableName} AS "tableName",
          name,
          type,
          "notnull" AS "notNull",
          dflt_value AS "defaultValue",
          pk AS "primaryKey"
        FROM pragma_table_info(${tableName})
        ORDER BY name ASC
      `,
    { concurrency: 1 },
  );

  const indexGroups = yield* Effect.forEach(
    coreRepairTables,
    (tableName) =>
      sql<{
        readonly tableName: string;
        readonly name: string;
      }>`
        SELECT
          tbl_name AS "tableName",
          name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = ${tableName}
          AND name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY name ASC
      `,
    { concurrency: 1 },
  );

  return {
    columns: columnGroups.flat(),
    indexes: indexGroups.flat(),
  };
});

const createProjectionStateTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES
      ('projection.threads', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.thread-messages', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.thread-activities', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.thread-sessions', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.thread-file-changes', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.thread-turns', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.checkpoints', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.pending-approvals', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.projects', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.project-memories', 50, '2026-05-05T00:00:00.000Z')
  `;
});

const createOldCoreProjectionTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      last_interaction_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_file_changes (
      file_change_id TEXT PRIMARY KEY
    )
  `;

  yield* sql`
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      pending_message_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL,
      UNIQUE (thread_id, turn_id),
      UNIQUE (thread_id, checkpoint_turn_count)
    )
  `;

  yield* sql`
    CREATE TABLE projection_pending_approvals (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
});

const expectCoreReadModelTables = (
  expectedProjectionStateRows: ReadonlyArray<{
    readonly projector: string;
    readonly lastAppliedSequence: number;
    readonly updatedAt: string;
  }> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const projectionStateRows = yield* sql`
    SELECT
      projector,
      last_applied_sequence AS "lastAppliedSequence",
      updated_at AS "updatedAt"
    FROM projection_state
    ORDER BY projector ASC
  `;

    assert.deepEqual(projectionStateRows, expectedProjectionStateRows);

    const threadRows = yield* sql`
    SELECT
      thread_id AS "threadId",
      project_id AS "projectId",
      title,
      model,
      model_selection_json AS "modelSelection",
      runtime_mode AS "runtimeMode",
      interaction_mode AS "interactionMode",
      branch,
      worktree_path AS "worktreePath",
      latest_turn_id AS "latestTurnId",
      tasks_json AS "tasks",
      tasks_turn_id AS "tasksTurnId",
      tasks_updated_at AS "tasksUpdatedAt",
      compaction_json AS "compaction",
      session_notes_json AS "sessionNotes",
      thread_references_json AS "threadReferences",
      archived_at AS "archivedAt",
      created_at AS "createdAt",
      last_interaction_at AS "lastInteractionAt",
      updated_at AS "updatedAt",
      deleted_at AS "deletedAt",
      estimated_context_tokens AS "estimatedContextTokens",
      model_context_window_tokens AS "modelContextWindowTokens"
    FROM projection_threads
    ORDER BY last_interaction_at DESC, created_at DESC, thread_id DESC
  `;

    assert.deepEqual(threadRows, []);

    const messageRows = yield* sql`
    SELECT
      message_id AS "messageId",
      thread_id AS "threadId",
      turn_id AS "turnId",
      role,
      text,
      reasoning_text AS "reasoningText",
      skill_call_json AS "skillCall",
      attachments_json AS "attachments",
      is_streaming AS "isStreaming",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_thread_messages
    ORDER BY thread_id ASC, created_at ASC, message_id ASC
  `;

    assert.deepEqual(messageRows, []);

    const activityRows = yield* sql`
    SELECT
      activity_id AS "activityId",
      thread_id AS "threadId",
      turn_id AS "turnId",
      tone,
      kind,
      summary,
      payload_json AS "payload",
      sequence,
      created_at AS "createdAt"
    FROM projection_thread_activities
    ORDER BY
      thread_id ASC,
      CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
      sequence ASC,
      created_at ASC,
      activity_id ASC
  `;

    assert.deepEqual(activityRows, []);

    const sessionRows = yield* sql`
    SELECT
      thread_id AS "threadId",
      status,
      provider_name AS "providerName",
      provider_instance_id AS "providerInstanceId",
      provider_session_id AS "providerSessionId",
      provider_thread_id AS "providerThreadId",
      runtime_mode AS "runtimeMode",
      active_turn_id AS "activeTurnId",
      last_error AS "lastError",
      estimated_context_tokens AS "estimatedContextTokens",
      model_context_window_tokens AS "modelContextWindowTokens",
      token_usage_source AS "tokenUsageSource",
      updated_at AS "updatedAt"
    FROM projection_thread_sessions
    ORDER BY thread_id ASC
  `;

    assert.deepEqual(sessionRows, []);

    const fileChangeRows = yield* sql`
    SELECT
      file_change_id AS id,
      thread_id AS "threadId",
      turn_id AS "turnId",
      provider_item_id AS "providerItemId",
      title,
      detail,
      status,
      changed_files AS "changedFiles",
      patch,
      started_sequence AS "startedSequence",
      last_updated_sequence AS "lastUpdatedSequence",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      updated_at AS "updatedAt"
    FROM projection_thread_file_changes
    ORDER BY thread_id ASC, started_at ASC, started_sequence ASC, file_change_id ASC
  `;

    assert.deepEqual(fileChangeRows, []);

    const latestTurnRows = yield* sql`
    SELECT
      thread_id AS "threadId",
      turn_id AS "turnId",
      state,
      requested_at AS "requestedAt",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      assistant_message_id AS "assistantMessageId"
    FROM projection_turns
    WHERE turn_id IS NOT NULL
    ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
  `;

    assert.deepEqual(latestTurnRows, []);

    const checkpointRows = yield* sql`
    SELECT
      thread_id AS "threadId",
      turn_id AS "turnId",
      checkpoint_turn_count AS "checkpointTurnCount",
      checkpoint_ref AS "checkpointRef",
      checkpoint_status AS "status",
      checkpoint_files_json AS "files",
      assistant_message_id AS "assistantMessageId",
      completed_at AS "completedAt"
    FROM projection_turns
    WHERE checkpoint_turn_count IS NOT NULL
    ORDER BY thread_id ASC, checkpoint_turn_count ASC
  `;

    assert.deepEqual(checkpointRows, []);

    const pendingApprovalRows = yield* sql`
    SELECT
      request_id AS "requestId",
      thread_id AS "threadId",
      turn_id AS "turnId",
      status,
      decision,
      created_at AS "createdAt",
      resolved_at AS "resolvedAt"
    FROM projection_pending_approvals
    ORDER BY thread_id ASC, created_at ASC, request_id ASC
  `;

    assert.deepEqual(pendingApprovalRows, []);
  });

const insertRowsInCoreTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model,
      runtime_mode,
      interaction_mode,
      tasks_json,
      thread_references_json,
      created_at,
      last_interaction_at,
      updated_at
    )
    VALUES (
      'thread-1',
      'project-1',
      'Thread',
      'gpt-5-codex',
      'full-access',
      'default',
      '[]',
      '[]',
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at
    )
    VALUES (
      'message-1',
      'thread-1',
      'turn-1',
      'user',
      'hello',
      0,
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      payload_json,
      created_at
    )
    VALUES (
      'activity-1',
      'thread-1',
      'turn-1',
      'info',
      'status',
      'Working',
      '{}',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      runtime_mode,
      updated_at
    )
    VALUES (
      'thread-1',
      'idle',
      'codex',
      'full-access',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_file_changes (
      file_change_id,
      thread_id,
      turn_id,
      provider_item_id,
      title,
      detail,
      status,
      changed_files,
      patch,
      started_sequence,
      last_updated_sequence,
      started_at,
      completed_at,
      updated_at
    )
    VALUES (
      'file-change-1',
      'thread-1',
      'turn-1',
      'provider-item-1',
      'File change',
      NULL,
      'completed',
      '["src/file.ts"]',
      '',
      1,
      2,
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:02.000Z',
      '2026-05-05T00:00:02.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      completed_at,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_status,
      checkpoint_files_json
    )
    VALUES (
      'thread-1',
      'turn-1',
      NULL,
      'message-2',
      'completed',
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:02.000Z',
      1,
      'checkpoint-1',
      'completed',
      '[]'
    )
  `;

  yield* sql`
    INSERT INTO projection_pending_approvals (
      request_id,
      thread_id,
      turn_id,
      status,
      created_at
    )
    VALUES (
      'approval-1',
      'thread-1',
      'turn-1',
      'pending',
      '2026-05-05T00:00:01.000Z'
    )
  `;
});

const insertRowsInOldCoreProjectionTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model,
      created_at,
      last_interaction_at,
      updated_at
    )
    VALUES (
      'thread-1',
      'project-1',
      'Thread',
      'gpt-5-codex',
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at
    )
    VALUES (
      'message-1',
      'thread-1',
      'turn-1',
      'user',
      'hello',
      0,
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      payload_json,
      created_at
    )
    VALUES (
      'activity-1',
      'thread-1',
      'turn-1',
      'info',
      'status',
      'Working',
      '{}',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      updated_at
    )
    VALUES (
      'thread-1',
      'idle',
      'codex',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_file_changes (file_change_id)
    VALUES ('file-change-1')
  `;

  yield* sql`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      completed_at,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_status,
      checkpoint_files_json
    )
    VALUES (
      'thread-1',
      'turn-1',
      NULL,
      'message-2',
      'completed',
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:02.000Z',
      1,
      'checkpoint-1',
      'completed',
      '[]'
    )
  `;

  yield* sql`
    INSERT INTO projection_pending_approvals (
      request_id,
      thread_id,
      turn_id,
      status,
      created_at
    )
    VALUES (
      'approval-1',
      'thread-1',
      'turn-1',
      'pending',
      '2026-05-05T00:00:01.000Z'
    )
  `;
});

layer("048_ProjectionCoreSchemaRepair", (it) => {
  it.effect("matches the full migration schema for core repaired tables", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* runMigrations;
      const canonicalSchema = yield* readCoreRepairSchemaSummary;

      yield* resetDatabase;
      yield* Migration0048;
      const repairedSchema = yield* readCoreRepairSchemaSummary;

      assert.deepEqual(repairedSchema, canonicalSchema);
    }),
  );

  it.effect("creates missing core projection tables", () =>
    Effect.gen(function* () {
      yield* resetDatabase;

      yield* Migration0048;
      yield* Migration0048;

      yield* expectCoreReadModelTables();
    }),
  );

  it.effect("adds current columns to old core projection table shapes", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createProjectionStateTable;
      yield* createOldCoreProjectionTables;

      yield* Migration0048;
      yield* Migration0048;

      yield* expectCoreReadModelTables([
        {
          projector: "projection.pending-approvals",
          lastAppliedSequence: 50,
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
        {
          projector: "projection.project-memories",
          lastAppliedSequence: 50,
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
        {
          projector: "projection.projects",
          lastAppliedSequence: 50,
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("resets affected projector cursors when it recreates missing tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* createProjectionStateTable;

      yield* Migration0048;

      const rows = yield* sql<{ readonly projector: string }>`
        SELECT projector
        FROM projection_state
        ORDER BY projector ASC
      `;

      assert.deepEqual(rows, [
        { projector: "projection.project-memories" },
        { projector: "projection.projects" },
      ]);
    }),
  );

  it.effect("resets affected projector cursors when it adds missing columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* createProjectionStateTable;
      yield* createOldCoreProjectionTables;

      yield* Migration0048;

      const rows = yield* sql<{ readonly projector: string }>`
        SELECT projector
        FROM projection_state
        ORDER BY projector ASC
      `;

      assert.deepEqual(rows, [
        { projector: "projection.pending-approvals" },
        { projector: "projection.project-memories" },
        { projector: "projection.projects" },
      ]);
    }),
  );

  it.effect("preserves existing core rows when no repair is needed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* Migration0048;
      yield* createProjectionStateTable;
      yield* insertRowsInCoreTables;

      yield* Migration0048;

      const counts = yield* sql<{
        readonly projectionState: number;
        readonly threads: number;
        readonly messages: number;
        readonly activities: number;
        readonly sessions: number;
        readonly fileChanges: number;
        readonly turns: number;
        readonly pendingApprovals: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_state) AS "projectionState",
          (SELECT COUNT(*) FROM projection_threads) AS threads,
          (SELECT COUNT(*) FROM projection_thread_messages) AS messages,
          (SELECT COUNT(*) FROM projection_thread_activities) AS activities,
          (SELECT COUNT(*) FROM projection_thread_sessions) AS sessions,
          (SELECT COUNT(*) FROM projection_thread_file_changes) AS "fileChanges",
          (SELECT COUNT(*) FROM projection_turns) AS turns,
          (SELECT COUNT(*) FROM projection_pending_approvals) AS "pendingApprovals"
      `;

      assert.deepEqual(counts, [
        {
          projectionState: 10,
          threads: 1,
          messages: 1,
          activities: 1,
          sessions: 1,
          fileChanges: 1,
          turns: 1,
          pendingApprovals: 1,
        },
      ]);
    }),
  );

  it.effect("preserves populated old-shape rows while adding missing columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* createProjectionStateTable;
      yield* createOldCoreProjectionTables;
      yield* insertRowsInOldCoreProjectionTables;

      yield* Migration0048;

      const rows = yield* sql<{
        readonly threadId: string;
        readonly threadRuntimeMode: string;
        readonly threadReferencesJson: string;
        readonly messageId: string;
        readonly messageSkillCallJson: string | null;
        readonly activityId: string;
        readonly activitySequence: number | null;
        readonly sessionProviderInstanceId: string | null;
        readonly sessionRuntimeMode: string;
        readonly fileChangeId: string;
        readonly fileChangeStatus: string;
        readonly fileChangeChangedFiles: string;
        readonly fileChangePatch: string;
        readonly turnId: string | null;
        readonly turnSourceProposedPlanThreadId: string | null;
        readonly approvalId: string;
      }>`
        SELECT
          (SELECT thread_id FROM projection_threads) AS "threadId",
          (SELECT runtime_mode FROM projection_threads) AS "threadRuntimeMode",
          (SELECT thread_references_json FROM projection_threads) AS "threadReferencesJson",
          (SELECT message_id FROM projection_thread_messages) AS "messageId",
          (SELECT skill_call_json FROM projection_thread_messages) AS "messageSkillCallJson",
          (SELECT activity_id FROM projection_thread_activities) AS "activityId",
          (SELECT sequence FROM projection_thread_activities) AS "activitySequence",
          (SELECT provider_instance_id FROM projection_thread_sessions) AS "sessionProviderInstanceId",
          (SELECT runtime_mode FROM projection_thread_sessions) AS "sessionRuntimeMode",
          (SELECT file_change_id FROM projection_thread_file_changes) AS "fileChangeId",
          (SELECT status FROM projection_thread_file_changes) AS "fileChangeStatus",
          (SELECT changed_files FROM projection_thread_file_changes) AS "fileChangeChangedFiles",
          (SELECT patch FROM projection_thread_file_changes) AS "fileChangePatch",
          (SELECT turn_id FROM projection_turns) AS "turnId",
          (SELECT source_proposed_plan_thread_id FROM projection_turns)
            AS "turnSourceProposedPlanThreadId",
          (SELECT request_id FROM projection_pending_approvals) AS "approvalId"
      `;

      assert.deepEqual(rows, [
        {
          threadId: "thread-1",
          threadRuntimeMode: "full-access",
          threadReferencesJson: "[]",
          messageId: "message-1",
          messageSkillCallJson: null,
          activityId: "activity-1",
          activitySequence: null,
          sessionProviderInstanceId: "codex",
          sessionRuntimeMode: "full-access",
          fileChangeId: "file-change-1",
          fileChangeStatus: "interrupted",
          fileChangeChangedFiles: "[]",
          fileChangePatch: "",
          turnId: "turn-1",
          turnSourceProposedPlanThreadId: null,
          approvalId: "approval-1",
        },
      ]);
    }),
  );

  it.effect("runs as the latest repair for already-advanced databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* seedMigrationTableAt(47, "ProjectionReadModelStartupTablesRepair");

      yield* runMigrations;

      yield* expectCoreReadModelTables();

      const latestMigration = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;

      assert.deepEqual(latestMigration, [
        {
          migrationId: 50,
          name: "CopyDebugWorkflowsToInvestigationWorkflows",
        },
      ]);
    }),
  );
});
