import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases that advanced past read-model table migrations while
 * missing tables required by startup snapshot queries.
 *
 * This covers read-model tables added after the base projection schema. Core
 * projection tables are owned by migration 005 and narrower repair migrations.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectorsToReset = new Set<string>();

  const projectMemoryTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_project_memories'
  `;
  if (projectMemoryTables.length === 0) {
    projectorsToReset.add("projection.project-memories");
  }

  // Keep in sync with 024_ProjectionProjectMemories.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_memories (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_project_memories_project_id_idx
    ON projection_project_memories (project_id, deleted_at, updated_at DESC)
  `;

  const projectSkillTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_project_skills'
  `;
  if (projectSkillTables.length === 0) {
    projectorsToReset.add("projection.project-skills");
  }

  // Keep in sync with 026_ProjectionProjectSkills.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_skills (
      skill_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      command_name TEXT NOT NULL,
      display_name TEXT,
      description TEXT NOT NULL,
      argument_hint TEXT,
      allowed_tools_json TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS projection_project_skills_project_command_name_idx
    ON projection_project_skills (project_id, command_name)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_project_skills_project_updated_at_idx
    ON projection_project_skills (project_id, updated_at DESC)
  `;

  const planningWorkflowTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_planning_workflows'
  `;
  if (planningWorkflowTables.length === 0) {
    projectorsToReset.add("projection.planning-workflows");
  }

  // Keep in sync with 020_ProjectionPlanningWorkflows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_planning_workflows (
      workflow_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_planning_workflows_project
    ON projection_planning_workflows(project_id, updated_at DESC)
  `;

  const codeReviewWorkflowTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_code_review_workflows'
  `;
  if (codeReviewWorkflowTables.length === 0) {
    projectorsToReset.add("projection.code-review-workflows");
  }

  // Keep in sync with 021_ProjectionCodeReviewWorkflows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_code_review_workflows (
      workflow_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_code_review_workflows_project
    ON projection_code_review_workflows(project_id, updated_at DESC)
  `;

  const proposedPlanTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_thread_proposed_plans'
  `;
  if (proposedPlanTables.length === 0) {
    projectorsToReset.add("projection.thread-proposed-plans");
  }

  // Keep in sync with 013_ProjectionThreadProposedPlans and
  // 014_ProjectionThreadProposedPlanImplementation.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      implemented_at TEXT,
      implementation_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const proposedPlanColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_proposed_plans')
  `;
  const existingProposedPlanColumns = new Set(proposedPlanColumns.map((column) => column.name));

  if (!existingProposedPlanColumns.has("implemented_at")) {
    projectorsToReset.add("projection.thread-proposed-plans");
    yield* sql`
      ALTER TABLE projection_thread_proposed_plans
      ADD COLUMN implemented_at TEXT
    `;
  }

  if (!existingProposedPlanColumns.has("implementation_thread_id")) {
    projectorsToReset.add("projection.thread-proposed-plans");
    yield* sql`
      ALTER TABLE projection_thread_proposed_plans
      ADD COLUMN implementation_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created
    ON projection_thread_proposed_plans(thread_id, created_at)
  `;

  const projectionStateTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_state'
  `;

  if (projectionStateTables.length > 0 && projectorsToReset.size > 0) {
    yield* Effect.forEach(
      Array.from(projectorsToReset),
      (projector) => sql`DELETE FROM projection_state WHERE projector = ${projector}`,
      { discard: true },
    );
  }
});
