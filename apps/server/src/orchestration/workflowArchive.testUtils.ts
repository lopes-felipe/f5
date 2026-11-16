import {
  CommandId,
  PlanningWorkflowId,
  CodeReviewWorkflowId,
  InvestigationWorkflowId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  buildPlanningWorkflowRecord,
  buildCodeReviewWorkflowRecord,
  buildInvestigationWorkflowRecord,
} from "./workflowRecordBuilders.ts";
import { workflowEntries } from "./workflowArchiveLifecycle.ts";

export function applyArchiveTestCommand(
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decision = Effect.runSync(decideOrchestrationCommand({ readModel: model, command }));
  const events = (Array.isArray(decision) ? decision : [decision]) as Omit<
    OrchestrationEvent,
    "sequence"
  >[];
  for (const event of events)
    model = Effect.runSync(
      projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 } as OrchestrationEvent),
    );
  return { model, events };
}

export function workflowArchiveFixture(kind: "planning" | "codeReview" | "investigation") {
  const createdAt = "2026-10-01T10:00:00.000Z";
  const projectId = ProjectId.makeUnsafe("archive-project");
  const a = ThreadId.makeUnsafe("archive-a");
  const b = ThreadId.makeUnsafe("archive-b");
  const slot = { provider: "codex" as const, model: "gpt-5-codex" };
  const base = { projectId, title: "Workflow", slug: "workflow", templateVersion: 1, createdAt };
  const workflow =
    kind === "planning"
      ? buildPlanningWorkflowRecord({
          ...base,
          workflowId: PlanningWorkflowId.makeUnsafe("workflow"),
          templateId: "builtin.planning.dual",
          requirementPrompt: "Plan",
          plansDirectory: "/repo/plans",
          selfReviewEnabled: false,
          authorThreadIdA: a,
          authorThreadIdB: b,
          branchA: slot,
          branchB: slot,
          merge: slot,
        })
      : kind === "codeReview"
        ? buildCodeReviewWorkflowRecord({
            ...base,
            workflowId: CodeReviewWorkflowId.makeUnsafe("workflow"),
            templateId: "builtin.code-review.dual",
            reviewPrompt: "Review",
            branch: null,
            reviewThreadIdA: a,
            reviewThreadIdB: b,
            reviewerA: slot,
            reviewerB: slot,
            consolidation: slot,
          })
        : buildInvestigationWorkflowRecord({
            ...base,
            workflowId: InvestigationWorkflowId.makeUnsafe("workflow"),
            templateId: "builtin.investigation.dual",
            problemPrompt: "Investigate",
            branch: null,
            selfReviewEnabled: false,
            investigationThreadIdA: a,
            investigationThreadIdB: b,
            investigatorA: slot,
            investigatorB: slot,
            synthesis: slot,
          });
  let model = applyArchiveTestCommand(createEmptyReadModel(createdAt), {
    type: "project.create",
    commandId: CommandId.makeUnsafe("project"),
    projectId,
    title: "Project",
    workspaceRoot: "/repo",
    createdAt,
  }).model;
  for (const threadId of [a, b])
    model = applyArchiveTestCommand(model, {
      type: "thread.create",
      commandId: CommandId.makeUnsafe(threadId),
      projectId,
      threadId,
      title: "Thread",
      model: slot.model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    }).model;
  // Builders are discriminated by kind above; install the corresponding typed record.
  if (kind === "planning")
    model = {
      ...model,
      planningWorkflows: [workflow as ReturnType<typeof buildPlanningWorkflowRecord>],
    };
  else if (kind === "codeReview")
    model = {
      ...model,
      codeReviewWorkflows: [workflow as ReturnType<typeof buildCodeReviewWorkflowRecord>],
    };
  else
    model = {
      ...model,
      investigationWorkflows: [workflow as ReturnType<typeof buildInvestigationWorkflowRecord>],
    };
  const archive = (restore = false): OrchestrationCommand => ({
    type: restore ? "project.workflow.unarchive" : "project.workflow.archive",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    projectId,
    workflowKind: kind,
    workflowId: workflow.id,
    createdAt: "2026-10-19T10:00:00.000Z",
  });
  return { model, archive, a, b, entry: workflowEntries(model)[0]! };
}
