import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0047 from "./047_ProjectionReadModelStartupTablesRepair.ts";

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

const createOldProjectionThreadProposedPlansTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});

const insertOldProjectionThreadProposedPlanRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_thread_proposed_plans (
      plan_id,
      thread_id,
      turn_id,
      plan_markdown,
      created_at,
      updated_at
    )
    VALUES (
      'plan-1',
      'thread-1',
      'turn-1',
      'Plan',
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;
});

const createProjectionProjectsTable = Effect.gen(function* () {
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

const createProjectionStateTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES
      ('projection.project-memories', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.project-skills', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.planning-workflows', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.code-review-workflows', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.thread-proposed-plans', 50, '2026-05-05T00:00:00.000Z'),
      ('projection.threads', 50, '2026-05-05T00:00:00.000Z')
  `;
});

const expectStartupReadModelTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const memoryRows = yield* sql`
    SELECT
      memory_id AS "memoryId",
      project_id AS "projectId",
      scope,
      type,
      name,
      description,
      body,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM projection_project_memories
    ORDER BY project_id ASC, updated_at DESC, memory_id ASC
  `;

  assert.deepEqual(memoryRows, []);

  const skillRows = yield* sql`
    SELECT
      project_id AS "projectId",
      skill_id AS "id",
      scope,
      command_name AS "commandName",
      display_name AS "displayName",
      description,
      argument_hint AS "argumentHint",
      allowed_tools_json AS "allowedTools",
      paths_json AS "paths",
      updated_at AS "updatedAt"
    FROM projection_project_skills
    ORDER BY project_id ASC, scope ASC, command_name ASC, skill_id ASC
  `;

  assert.deepEqual(skillRows, []);

  const planningWorkflowRows = yield* sql`
    SELECT
      workflow_id AS "workflowId",
      project_id AS "projectId",
      workflow_json AS "workflow"
    FROM projection_planning_workflows
    ORDER BY updated_at DESC, workflow_id DESC
  `;

  assert.deepEqual(planningWorkflowRows, []);

  const codeReviewWorkflowRows = yield* sql`
    SELECT
      workflow_id AS "workflowId",
      project_id AS "projectId",
      workflow_json AS "workflow"
    FROM projection_code_review_workflows
    ORDER BY updated_at DESC, workflow_id DESC
  `;

  assert.deepEqual(codeReviewWorkflowRows, []);

  const proposedPlanRows = yield* sql`
    SELECT
      plan_id AS "planId",
      thread_id AS "threadId",
      turn_id AS "turnId",
      plan_markdown AS "planMarkdown",
      implemented_at AS "implementedAt",
      implementation_thread_id AS "implementationThreadId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_thread_proposed_plans
    ORDER BY thread_id ASC, created_at ASC, plan_id ASC
  `;

  assert.deepEqual(proposedPlanRows, []);
});

const insertRowsInStartupReadModelTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_project_memories (
      memory_id,
      project_id,
      scope,
      type,
      name,
      description,
      body,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      'memory-1',
      'project-1',
      'project',
      'project',
      'Memory',
      'Description',
      'Body',
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:01.000Z',
      NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_project_skills (
      skill_id,
      project_id,
      scope,
      command_name,
      display_name,
      description,
      argument_hint,
      allowed_tools_json,
      paths_json,
      updated_at
    )
    VALUES (
      'skill-1',
      'project-1',
      'project',
      'run-skill',
      'Run Skill',
      'Description',
      NULL,
      '[]',
      '[]',
      '2026-05-05T00:00:01.000Z'
    )
  `;

  yield* sql`
    INSERT INTO projection_planning_workflows (
      workflow_id,
      project_id,
      workflow_json,
      updated_at,
      deleted_at
    )
    VALUES (
      'planning-1',
      'project-1',
      '{}',
      '2026-05-05T00:00:01.000Z',
      NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_code_review_workflows (
      workflow_id,
      project_id,
      workflow_json,
      updated_at,
      deleted_at
    )
    VALUES (
      'code-review-1',
      'project-1',
      '{}',
      '2026-05-05T00:00:01.000Z',
      NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_proposed_plans (
      plan_id,
      thread_id,
      turn_id,
      plan_markdown,
      implemented_at,
      implementation_thread_id,
      created_at,
      updated_at
    )
    VALUES (
      'plan-1',
      'thread-1',
      NULL,
      'Plan',
      NULL,
      NULL,
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:01.000Z'
    )
  `;
});

layer("047_ProjectionReadModelStartupTablesRepair", (it) => {
  it.effect("creates missing startup read-model tables", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createProjectionProjectsTable;

      yield* Migration0047;
      yield* Migration0047;

      yield* expectStartupReadModelTables;
    }),
  );

  it.effect("adds proposed plan implementation columns to old table shapes", () =>
    Effect.gen(function* () {
      yield* resetDatabase;
      yield* createProjectionProjectsTable;
      yield* createOldProjectionThreadProposedPlansTable;

      yield* Migration0047;
      yield* Migration0047;

      yield* expectStartupReadModelTables;
    }),
  );

  it.effect("preserves old proposed plan rows while adding implementation columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* createProjectionProjectsTable;
      yield* createProjectionStateTable;
      yield* createOldProjectionThreadProposedPlansTable;
      yield* insertOldProjectionThreadProposedPlanRow;

      yield* Migration0047;

      const rows = yield* sql<{
        readonly planId: string;
        readonly implementedAt: string | null;
        readonly implementationThreadId: string | null;
      }>`
        SELECT
          plan_id AS "planId",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId"
        FROM projection_thread_proposed_plans
      `;

      assert.deepEqual(rows, [
        {
          planId: "plan-1",
          implementedAt: null,
          implementationThreadId: null,
        },
      ]);
    }),
  );

  it.effect("resets affected projector cursors when it recreates missing tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* createProjectionProjectsTable;
      yield* createProjectionStateTable;
      yield* createOldProjectionThreadProposedPlansTable;

      yield* Migration0047;

      const rows = yield* sql<{ readonly projector: string }>`
        SELECT projector
        FROM projection_state
        ORDER BY projector ASC
      `;

      assert.deepEqual(rows, [{ projector: "projection.threads" }]);
    }),
  );

  it.effect("preserves existing read-model rows when no repair is needed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* createProjectionProjectsTable;
      yield* Migration0047;
      yield* createProjectionStateTable;
      yield* insertRowsInStartupReadModelTables;

      yield* Migration0047;

      const counts = yield* sql<{
        readonly projectMemories: number;
        readonly projectSkills: number;
        readonly planningWorkflows: number;
        readonly codeReviewWorkflows: number;
        readonly proposedPlans: number;
        readonly projectionState: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_project_memories) AS "projectMemories",
          (SELECT COUNT(*) FROM projection_project_skills) AS "projectSkills",
          (SELECT COUNT(*) FROM projection_planning_workflows) AS "planningWorkflows",
          (SELECT COUNT(*) FROM projection_code_review_workflows) AS "codeReviewWorkflows",
          (SELECT COUNT(*) FROM projection_thread_proposed_plans) AS "proposedPlans",
          (SELECT COUNT(*) FROM projection_state) AS "projectionState"
      `;

      assert.deepEqual(counts, [
        {
          projectMemories: 1,
          projectSkills: 1,
          planningWorkflows: 1,
          codeReviewWorkflows: 1,
          proposedPlans: 1,
          projectionState: 6,
        },
      ]);
    }),
  );

  it.effect("runs as the latest repair for already-advanced databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* resetDatabase;
      yield* seedMigrationTableAt(46, "ProjectionProjectsSchemaRepair");
      yield* createProjectionProjectsTable;

      yield* runMigrations;

      yield* expectStartupReadModelTables;

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
});
