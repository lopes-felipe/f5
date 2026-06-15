import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0033 from "./033_ProjectMcpConfigScopes.ts";
import Migration0043 from "./043_ProjectMcpConfigsSchemaRepair.ts";

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

const createOldProjectMcpConfigsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE project_mcp_configs (
      project_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      servers_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO project_mcp_configs (
      project_id,
      version,
      servers_json,
      updated_at
    )
    VALUES (
      'project-1',
      'version-1',
      '{"filesystem":{"type":"stdio","command":"npx"}}',
      '2026-04-15T00:00:00.000Z'
    )
  `;
});

const createStaleProjectMcpConfigsNextTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE project_mcp_configs_next (
      scope_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      version TEXT NOT NULL,
      servers_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});

const createPost32SchemaExceptProjectMcpConfigs = Effect.gen(function* () {
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
      provider_name TEXT,
      project_id TEXT,
      mcp_config_version TEXT
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

const expectScopedProjectMcpConfigsTable = (
  expectedRows: ReadonlyArray<{
    readonly scopeKey: string;
    readonly scope: string;
    readonly projectId: string | null;
    readonly version: string;
    readonly serversJson: string;
    readonly updatedAt: string;
  }> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const columns = yield* sql<{ readonly name: string; readonly type: string }>`
      SELECT name, type
      FROM pragma_table_info('project_mcp_configs')
      ORDER BY cid ASC
    `;

    assert.deepEqual(columns, [
      { name: "scope_key", type: "TEXT" },
      { name: "scope", type: "TEXT" },
      { name: "project_id", type: "TEXT" },
      { name: "version", type: "TEXT" },
      { name: "servers_json", type: "TEXT" },
      { name: "updated_at", type: "TEXT" },
    ]);

    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'project_mcp_configs'
        AND name IN (
          'idx_project_mcp_configs_project_id',
          'idx_project_mcp_configs_updated_at'
        )
      ORDER BY name ASC
    `;

    assert.deepEqual(
      indexes.map((index) => index.name),
      ["idx_project_mcp_configs_project_id", "idx_project_mcp_configs_updated_at"],
    );

    const rows = yield* sql<{
      readonly scopeKey: string;
      readonly scope: string;
      readonly projectId: string | null;
      readonly version: string;
      readonly serversJson: string;
      readonly updatedAt: string;
    }>`
      SELECT
        scope_key AS "scopeKey",
        scope,
        project_id AS "projectId",
        version,
        servers_json AS "serversJson",
        updated_at AS "updatedAt"
      FROM project_mcp_configs
      ORDER BY scope_key ASC
    `;

    assert.deepEqual(rows, expectedRows);
  });

layer("033_ProjectMcpConfigScopes", (it) => {
  it.effect("creates the scoped table when the legacy table is missing", () =>
    Effect.gen(function* () {
      yield* resetDatabase;

      yield* Migration0033;
      yield* Migration0033;

      yield* expectScopedProjectMcpConfigsTable();
    }),
  );

  it.effect("migrates existing project rows to project-scoped keys", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createOldProjectMcpConfigsTable;

      yield* Migration0033;
      yield* Migration0033;

      yield* expectScopedProjectMcpConfigsTable([
        {
          scopeKey: "project:project-1",
          scope: "project",
          projectId: "project-1",
          version: "version-1",
          serversJson: '{"filesystem":{"type":"stdio","command":"npx"}}',
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("runs remaining migrations from a post-32 database missing MCP configs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* seedMigrationTableAt(32, "ProviderSessionRuntimeProjectMcp");
      yield* createPost32SchemaExceptProjectMcpConfigs;

      yield* runMigrations;

      yield* expectScopedProjectMcpConfigsTable();

      const latestMigration = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;

      assert.deepEqual(latestMigration, [
        {
          migrationId: 44,
          name: "ProjectionThreadCommandExecutionsSchemaRepair",
        },
      ]);
    }),
  );

  it.effect("repairs already-advanced databases that are missing MCP configs", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* seedMigrationTableAt(42, "ProjectionThreadMessagesSkillCall");

      yield* runMigrations;

      yield* expectScopedProjectMcpConfigsTable();
    }),
  );

  it.effect("repairs already-advanced databases that still have the old table shape", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* seedMigrationTableAt(42, "ProjectionThreadMessagesSkillCall");
      yield* createOldProjectMcpConfigsTable;

      yield* runMigrations;

      yield* expectScopedProjectMcpConfigsTable([
        {
          scopeKey: "project:project-1",
          scope: "project",
          projectId: "project-1",
          version: "version-1",
          serversJson: '{"filesystem":{"type":"stdio","command":"npx"}}',
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("migration 43 creates the scoped table when the table is missing", () =>
    Effect.gen(function* () {
      yield* resetDatabase;

      yield* Migration0043;
      yield* Migration0043;

      yield* expectScopedProjectMcpConfigsTable();
    }),
  );

  it.effect("migration 43 migrates existing project rows", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createOldProjectMcpConfigsTable;

      yield* Migration0043;
      yield* Migration0043;

      yield* expectScopedProjectMcpConfigsTable([
        {
          scopeKey: "project:project-1",
          scope: "project",
          projectId: "project-1",
          version: "version-1",
          serversJson: '{"filesystem":{"type":"stdio","command":"npx"}}',
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("migration 43 removes stale temporary tables before migrating", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createOldProjectMcpConfigsTable;
      yield* createStaleProjectMcpConfigsNextTable;

      yield* Migration0043;

      yield* expectScopedProjectMcpConfigsTable([
        {
          scopeKey: "project:project-1",
          scope: "project",
          projectId: "project-1",
          version: "version-1",
          serversJson: '{"filesystem":{"type":"stdio","command":"npx"}}',
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ]);
    }),
  );
});
