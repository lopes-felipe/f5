import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0040 from "./040_ProjectionThreadsModelSelection.ts";
import Migration0045 from "./045_ProjectionThreadsModelSchemaRepair.ts";

const layer = it.layer(SqliteClient.layerMemory());

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

const createProjectionThreadSessionsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT,
      provider_instance_id TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      provider_name,
      provider_instance_id
    )
    VALUES (
      'thread-1',
      'codex',
      'codex-default'
    )
  `;
});

const createLegacyProjectionThreadsTableWithoutModel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
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
      created_at TEXT NOT NULL,
      last_interaction_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      runtime_mode,
      interaction_mode,
      created_at,
      last_interaction_at,
      updated_at
    )
    VALUES (
      'thread-1',
      'project-1',
      'Thread',
      'full-access',
      'default',
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:01.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;
});

const createProjectionThreadsTableWithModel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* createLegacyProjectionThreadsTableWithoutModel;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'
  `;
});

const createPost39SchemaExceptProjectionThreadModel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* createLegacyProjectionThreadsTableWithoutModel;
  yield* createProjectionThreadSessionsTable;

  yield* sql`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      default_model TEXT
    )
  `;

  yield* sql`
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});

const expectProjectionThreadsModelColumns = (expected: {
  readonly model: string;
  readonly modelSelectionJson: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_table_info('projection_threads')
      WHERE name IN ('model', 'model_selection_json')
      ORDER BY name ASC
    `;

    assert.deepEqual(
      columns.map((column) => column.name),
      ["model", "model_selection_json"],
    );

    const rows = yield* sql<{
      readonly model: string;
      readonly modelSelectionJson: string;
    }>`
      SELECT
        model,
        model_selection_json AS "modelSelectionJson"
      FROM projection_threads
      ORDER BY thread_id ASC
    `;

    assert.deepEqual(rows, [expected]);
  });

layer("040_ProjectionThreadsModelSelection", (it) => {
  it.effect("adds model and model_selection_json to legacy thread rows", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createLegacyProjectionThreadsTableWithoutModel;
      yield* createProjectionThreadSessionsTable;

      yield* Migration0040;
      yield* Migration0040;

      yield* expectProjectionThreadsModelColumns({
        model: "gpt-5-codex",
        modelSelectionJson: '{"instanceId":"codex-default","model":"gpt-5-codex"}',
      });
    }),
  );

  it.effect("preserves existing model values when backfilling model selections", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createProjectionThreadsTableWithModel;
      yield* createProjectionThreadSessionsTable;

      yield* Migration0040;

      yield* expectProjectionThreadsModelColumns({
        model: "claude-sonnet-4-6",
        modelSelectionJson: '{"instanceId":"codex-default","model":"claude-sonnet-4-6"}',
      });
    }),
  );

  it.effect("runs remaining migrations from a post-39 database missing thread model columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* seedMigrationTableAt(39, "ProjectionThreadSessionInstanceId");
      yield* createPost39SchemaExceptProjectionThreadModel;

      yield* runMigrations;

      yield* expectProjectionThreadsModelColumns({
        model: "gpt-5-codex",
        modelSelectionJson: '{"instanceId":"codex-default","model":"gpt-5-codex"}',
      });

      const latestMigration = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;

      assert.deepEqual(latestMigration, [
        {
          migrationId: 45,
          name: "ProjectionThreadsModelSchemaRepair",
        },
      ]);
    }),
  );

  it.effect("migration 45 repairs already-advanced databases", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createLegacyProjectionThreadsTableWithoutModel;
      yield* createProjectionThreadSessionsTable;

      yield* Migration0045;
      yield* Migration0045;

      yield* expectProjectionThreadsModelColumns({
        model: "gpt-5-codex",
        modelSelectionJson: '{"instanceId":"codex-default","model":"gpt-5-codex"}',
      });
    }),
  );
});
