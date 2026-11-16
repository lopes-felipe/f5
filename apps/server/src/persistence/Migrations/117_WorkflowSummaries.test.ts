import { Effect, Layer, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqlite from "../NodeSqliteClient.ts";
import { PlanningWorkflow, CodeReviewWorkflow, InvestigationWorkflow } from "@t3tools/contracts";
import migration from "./117_WorkflowSummaries.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { ProjectionPlanningWorkflowRepositoryLive } from "../Layers/ProjectionPlanningWorkflows.ts";
import { ProjectionPlanningWorkflowRepository } from "../Services/ProjectionPlanningWorkflows.ts";
import { ProjectionCodeReviewWorkflowRepositoryLive } from "../Layers/ProjectionCodeReviewWorkflows.ts";
import { ProjectionCodeReviewWorkflowRepository } from "../Services/ProjectionCodeReviewWorkflows.ts";
import { ProjectionInvestigationWorkflowRepositoryLive } from "../Layers/ProjectionInvestigationWorkflows.ts";
import { ProjectionInvestigationWorkflowRepository } from "../Services/ProjectionInvestigationWorkflows.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const at = "2026-10-01T00:00:00.000Z";
const slot = { provider: "codex", model: "gpt-5-codex" };
const branch = (id: string) => ({
  branchId: id,
  authorSlot: slot,
  authorThreadId: `author-${id}`,
  planFilePath: null,
  planTurnId: null,
  revisionTurnId: null,
  reviews: [],
  status: "pending",
  error: null,
  updatedAt: at,
});
const common = {
  id: "run",
  projectId: "project",
  title: "Run",
  slug: "run",
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};
const planning = Schema.decodeUnknownSync(PlanningWorkflow)({
  ...common,
  requirementPrompt: "large prompt".repeat(10_000),
  plansDirectory: "plans",
  branchA: branch("a"),
  branchB: branch("b"),
  merge: {
    mergeSlot: slot,
    threadId: null,
    outputFilePath: null,
    turnId: null,
    status: "not_started",
    error: null,
    updatedAt: at,
  },
});
const reviewer = {
  label: "Reviewer",
  slot,
  threadId: "reviewer",
  status: "pending",
  pinnedTurnId: null,
  pinnedAssistantMessageId: null,
  error: null,
  updatedAt: at,
};
const review = Schema.decodeUnknownSync(CodeReviewWorkflow)({
  ...common,
  id: "review",
  reviewPrompt: "review source".repeat(10_000),
  branch: null,
  reviewerA: reviewer,
  reviewerB: reviewer,
  consolidation: { ...reviewer, status: "not_started" },
});
const investigator = {
  label: "Investigator",
  slot,
  investigationThreadId: "investigator",
  investigationStatus: "pending",
  investigationTurnId: null,
  investigationMessageId: null,
  crossReviewThreadId: null,
  crossReviewStatus: "not_started",
  crossReviewTurnId: null,
  crossReviewMessageId: null,
  error: null,
  updatedAt: at,
};
const investigation = Schema.decodeUnknownSync(InvestigationWorkflow)({
  ...common,
  id: "investigation",
  problemPrompt: "investigate".repeat(10_000),
  branch: null,
  investigatorA: investigator,
  investigatorB: investigator,
  synthesis: { ...reviewer, status: "not_started" },
});

it.effect("migrates historical summaries without loading or changing full run JSON", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [table, workflow] of [
      ["projection_planning_workflows", planning],
      ["projection_code_review_workflows", review],
      ["projection_investigation_workflows", investigation],
    ] as const) {
      yield* sql.unsafe(
        `CREATE TABLE ${table}(workflow_id TEXT PRIMARY KEY, project_id TEXT, workflow_json TEXT, updated_at TEXT, deleted_at TEXT)`,
      );
      yield* sql.unsafe(`INSERT INTO ${table} VALUES (?, ?, ?, ?, NULL)`, [
        workflow.id,
        workflow.projectId,
        JSON.stringify(workflow),
        at,
      ]);
    }
    yield* migration;
    const rows = yield* sql<{
      workflow_json: string;
      summary_json: string;
    }>`SELECT * FROM projection_planning_workflows`;
    expect(rows[0]?.workflow_json).toBe(JSON.stringify(planning));
    expect(JSON.parse(rows[0]!.summary_json)).not.toHaveProperty("requirementPrompt");
    expect(JSON.parse(rows[0]!.summary_json)).not.toHaveProperty("plansDirectory");
  }).pipe(Effect.provide(NodeSqlite.layerMemory())),
);

it.effect(
  "reads indexed startup summaries, keeps full engine hydration, and projects updates/deletes",
  () =>
    Effect.gen(function* () {
      const plans = yield* ProjectionPlanningWorkflowRepository;
      const reviews = yield* ProjectionCodeReviewWorkflowRepository;
      const investigations = yield* ProjectionInvestigationWorkflowRepository;
      const query = yield* ProjectionSnapshotQuery;
      yield* plans.upsert(planning);
      yield* reviews.upsert(review);
      yield* investigations.upsert(investigation);
      const startup = yield* query.getStartupSnapshot();
      expect(startup.snapshot.planningWorkflows).toHaveLength(1);
      expect(startup.snapshot.codeReviewWorkflows).toHaveLength(1);
      expect(startup.snapshot.investigationWorkflows).toHaveLength(1);
      expect(JSON.stringify(startup).length).toBeLessThan(
        JSON.stringify([planning, review, investigation]).length / 10,
      );
      expect((yield* query.getBootstrapSnapshot()).planningWorkflows[0]?.requirementPrompt).toBe(
        planning.requirementPrompt,
      );
      yield* plans.upsert({ ...planning, title: "Updated", updatedAt: "2026-10-02T00:00:00.000Z" });
      expect((yield* query.getStartupSnapshot()).snapshot.planningWorkflows[0]?.title).toBe(
        "Updated",
      );
      yield* plans.deleteById({ workflowId: planning.id, deletedAt: "2026-10-03T00:00:00.000Z" });
      expect((yield* query.getStartupSnapshot()).snapshot.planningWorkflows).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProjectionPlanningWorkflowRepositoryLive,
          ProjectionCodeReviewWorkflowRepositoryLive,
          ProjectionInvestigationWorkflowRepositoryLive,
          OrchestrationProjectionSnapshotQueryLive,
        ).pipe(Layer.provide(SqlitePersistenceMemory)),
      ),
    ),
);
