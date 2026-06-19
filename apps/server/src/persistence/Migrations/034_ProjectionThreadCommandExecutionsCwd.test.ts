import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0034 from "./034_ProjectionThreadCommandExecutionsCwd.ts";
import Migration0044 from "./044_ProjectionThreadCommandExecutionsSchemaRepair.ts";

const layer = it.layer(SqliteClient.layerMemory());

const requiredColumnNames = [
  "command_execution_id",
  "thread_id",
  "turn_id",
  "provider_item_id",
  "command",
  "cwd",
  "title",
  "status",
  "detail",
  "output",
  "output_truncated",
  "exit_code",
  "started_sequence",
  "last_updated_sequence",
  "started_at",
  "completed_at",
  "updated_at",
]
  .slice()
  .sort();

const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `;

  yield* Effect.forEach(tables, ({ name }) => sql`DROP TABLE IF EXISTS ${sql(name)}`, {
    discard: true,
  });
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

const createOldCommandExecutionsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_command_executions (
      command_execution_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_item_id TEXT,
      command TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      output TEXT NOT NULL,
      output_truncated INTEGER NOT NULL,
      exit_code INTEGER,
      started_sequence INTEGER NOT NULL,
      last_updated_sequence INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_command_executions (
      command_execution_id,
      thread_id,
      turn_id,
      provider_item_id,
      command,
      title,
      status,
      detail,
      output,
      output_truncated,
      exit_code,
      started_sequence,
      last_updated_sequence,
      started_at,
      completed_at,
      updated_at
    )
    VALUES (
      'command-execution-1',
      'thread-1',
      'turn-1',
      'provider-item-1',
      'echo hello',
      'Echo',
      'completed',
      'detail',
      'hello',
      0,
      0,
      1,
      2,
      '2026-04-16T00:00:00.000Z',
      '2026-04-16T00:00:01.000Z',
      '2026-04-16T00:00:01.000Z'
    )
  `;
});

const createPost33SchemaExceptCommandExecutions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE projection_pending_approvals (
      request_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE provider_session_runtime (
      session_id TEXT PRIMARY KEY,
      provider_name TEXT
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT
    )
  `;

  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      model TEXT
    )
  `;

  yield* sql`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY
    )
  `;
});

const expectCommandExecutionsTable = (
  expectedRows: ReadonlyArray<{ readonly id: string; readonly cwd: string | null }> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_table_info('projection_thread_command_executions')
    `;

    assert.deepEqual(
      columns
        .map((column) => column.name)
        .slice()
        .sort(),
      requiredColumnNames,
    );

    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'projection_thread_command_executions'
        AND name IN (
          'idx_projection_thread_command_executions_thread_started',
          'idx_projection_thread_command_executions_thread_last_updated'
        )
      ORDER BY name ASC
    `;

    assert.deepEqual(
      indexes.map((index) => index.name),
      [
        "idx_projection_thread_command_executions_thread_last_updated",
        "idx_projection_thread_command_executions_thread_started",
      ],
    );

    const rows = yield* sql<{ readonly id: string; readonly cwd: string | null }>`
      SELECT command_execution_id AS id, cwd
      FROM projection_thread_command_executions
      ORDER BY command_execution_id ASC
    `;

    assert.deepEqual(rows, expectedRows);
  });

layer("034_ProjectionThreadCommandExecutionsCwd", (it) => {
  it.effect("creates the final table when the command executions table is missing", () =>
    Effect.gen(function* () {
      yield* resetDatabase;

      yield* Migration0034;
      yield* Migration0034;

      yield* expectCommandExecutionsTable();
    }),
  );

  it.effect("adds cwd to existing command execution rows", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createOldCommandExecutionsTable;

      yield* Migration0034;
      yield* Migration0034;

      yield* expectCommandExecutionsTable([{ id: "command-execution-1", cwd: null }]);
    }),
  );

  it.effect("runs remaining migrations from a post-33 database missing command executions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* seedMigrationTableAt(33, "ProjectMcpConfigScopes");
      yield* createPost33SchemaExceptCommandExecutions;

      yield* runMigrations;

      yield* expectCommandExecutionsTable();

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

  it.effect("migration 44 creates the table for already-advanced databases", () =>
    Effect.gen(function* () {
      yield* resetDatabase;

      yield* Migration0044;
      yield* Migration0044;

      yield* expectCommandExecutionsTable();
    }),
  );

  it.effect("migration 44 adds cwd to existing command execution rows", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createOldCommandExecutionsTable;

      yield* Migration0044;
      yield* Migration0044;

      yield* expectCommandExecutionsTable([{ id: "command-execution-1", cwd: null }]);
    }),
  );
});
