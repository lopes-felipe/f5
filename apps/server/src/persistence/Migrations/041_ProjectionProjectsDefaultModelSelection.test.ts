import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0041 from "./041_ProjectionProjectsDefaultModelSelection.ts";
import Migration0046 from "./046_ProjectionProjectsSchemaRepair.ts";

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

const createSkinnyProjectionProjectsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY
    )
  `;

  yield* sql`
    INSERT INTO projection_projects (project_id)
    VALUES ('project-1')
  `;
});

const createProjectionThreadMessagesTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});

const expectProjectionProjectsTable = (
  expectedRows: ReadonlyArray<{
    readonly projectId: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly defaultModel: string | null;
    readonly defaultModelSelection: string | null;
    readonly scripts: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly deletedAt: string | null;
  }> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_table_info('projection_projects')
      ORDER BY cid ASC
    `;

    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "project_id",
        "title",
        "workspace_root",
        "default_model",
        "scripts_json",
        "created_at",
        "updated_at",
        "deleted_at",
        "default_model_selection_json",
      ],
    );

    const rows = yield* sql<{
      readonly projectId: string;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly defaultModel: string | null;
      readonly defaultModelSelection: string | null;
      readonly scripts: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly deletedAt: string | null;
    }>`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot",
        default_model AS "defaultModel",
        default_model_selection_json AS "defaultModelSelection",
        scripts_json AS "scripts",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_projects
      ORDER BY project_id ASC
    `;

    assert.deepEqual(rows, expectedRows);
  });

layer("041_ProjectionProjectsDefaultModelSelection", (it) => {
  it.effect("creates the final projection_projects schema when the table is missing", () =>
    Effect.gen(function* () {
      yield* resetDatabase;

      yield* Migration0041;
      yield* Migration0041;

      yield* expectProjectionProjectsTable();
    }),
  );

  it.effect("repairs skinny project rows with startup-safe defaults", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createSkinnyProjectionProjectsTable;

      yield* Migration0041;
      yield* Migration0041;

      yield* expectProjectionProjectsTable([
        {
          projectId: "project-1",
          title: "",
          workspaceRoot: "",
          defaultModel: null,
          defaultModelSelection: null,
          scripts: "[]",
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          deletedAt: null,
        },
      ]);
    }),
  );

  it.effect("runs remaining migrations from a post-40 database with a skinny project table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* seedMigrationTableAt(40, "ProjectionThreadsModelSelection");
      yield* createSkinnyProjectionProjectsTable;
      yield* createProjectionThreadMessagesTable;

      yield* runMigrations;

      yield* expectProjectionProjectsTable([
        {
          projectId: "project-1",
          title: "",
          workspaceRoot: "",
          defaultModel: null,
          defaultModelSelection: null,
          scripts: "[]",
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          deletedAt: null,
        },
      ]);

      const latestMigration = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;

      assert.deepEqual(latestMigration, [
        {
          migrationId: 53,
          name: "PrHubAdvisories",
        },
      ]);
    }),
  );

  it.effect("migration 46 repairs already-advanced databases", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createSkinnyProjectionProjectsTable;

      yield* Migration0046;
      yield* Migration0046;

      yield* expectProjectionProjectsTable([
        {
          projectId: "project-1",
          title: "",
          workspaceRoot: "",
          defaultModel: null,
          defaultModelSelection: null,
          scripts: "[]",
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          deletedAt: null,
        },
      ]);
    }),
  );
});
