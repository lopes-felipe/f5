import ensurePlanningWorkflows from "./020_ProjectionPlanningWorkflows.ts";
import ensureCodeReviewWorkflows from "./021_ProjectionCodeReviewWorkflows.ts";
import ensureInvestigationWorkflows from "./049_ProjectionInvestigationWorkflows.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Older schema repairs can have advanced migration metadata but lack these tables.
  yield* ensurePlanningWorkflows;
  yield* ensureCodeReviewWorkflows;
  yield* ensureInvestigationWorkflows;
  for (const [table, paths] of [
    [
      "projection_planning_workflows",
      ["$.requirementPrompt", "$.plansDirectory", "$.implementation.reviewArtifact"],
    ],
    ["projection_code_review_workflows", ["$.reviewPrompt"]],
    ["projection_investigation_workflows", ["$.problemPrompt"]],
  ] as const) {
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === "summary_json"))
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}'`);
    yield* sql.unsafe(
      `UPDATE ${table} SET summary_json = json_remove(workflow_json, ${paths.map((path) => `'${path}'`).join(", ")})`,
    );
    yield* sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_${table}_summary ON ${table}(deleted_at, updated_at DESC, workflow_id DESC)`,
    );
  }
});
