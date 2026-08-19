import { Schema } from "effect";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import {
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationCreateInvestigationWorkflowInput,
  OrchestrationCreateWorkflowInput,
  ProjectMemory,
  ProjectSkill,
  ThreadCompaction,
  ThreadSessionNotes,
} from "./orchestration";
import { WorkflowModelSlot } from "./planningWorkflow";

export const WorkflowTemplateId = TrimmedNonEmptyString;
export type WorkflowTemplateId = typeof WorkflowTemplateId.Type;

export const WorkflowRunKind = Schema.Literals(["planning", "codeReview", "investigation"]);
export type WorkflowRunKind = typeof WorkflowRunKind.Type;

export const WorkflowNodeKind = Schema.Literals([
  "agent",
  "parallel-agent",
  "review",
  "synthesis",
  "manual-approval",
  "project-script",
]);
export type WorkflowNodeKind = typeof WorkflowNodeKind.Type;

export const WorkflowNodeRetryPolicy = Schema.Struct({
  maxAttempts: NonNegativeInt,
  backoffMs: NonNegativeInt,
});
export type WorkflowNodeRetryPolicy = typeof WorkflowNodeRetryPolicy.Type;

export const WorkflowNodeDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: WorkflowNodeKind,
  dependsOn: Schema.Array(TrimmedNonEmptyString),
  slotKeys: Schema.Array(TrimmedNonEmptyString),
  artifactType: Schema.NullOr(TrimmedNonEmptyString),
  optional: Schema.Boolean,
  retry: WorkflowNodeRetryPolicy,
  failurePolicy: Schema.Literals(["stop", "retry", "manual"]),
});
export type WorkflowNodeDefinition = typeof WorkflowNodeDefinition.Type;

export const WorkflowTemplateFormField = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  type: Schema.Literals(["text", "prompt", "boolean", "number", "model-slot", "branch"]),
  required: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
});
export type WorkflowTemplateFormField = typeof WorkflowTemplateFormField.Type;

export const WorkflowTemplate = Schema.Struct({
  id: WorkflowTemplateId,
  version: Schema.Int,
  runKind: WorkflowRunKind,
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  nodes: Schema.Array(WorkflowNodeDefinition),
  form: Schema.Array(WorkflowTemplateFormField),
});
export type WorkflowTemplate = typeof WorkflowTemplate.Type;

export const WorkflowPlatformListTemplatesResult = Schema.Struct({
  templates: Schema.Array(WorkflowTemplate),
});
export type WorkflowPlatformListTemplatesResult = typeof WorkflowPlatformListTemplatesResult.Type;

export const WorkflowPlatformCreateRunInput = Schema.Union([
  Schema.Struct({
    templateId: Schema.Literal("builtin.planning.dual"),
    templateVersion: Schema.optional(Schema.Literals([1, 2])),
    maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
    input: OrchestrationCreateWorkflowInput,
  }),
  Schema.Struct({
    templateId: Schema.Literal("builtin.code-review.dual"),
    templateVersion: Schema.optional(Schema.Literals([1, 2])),
    maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
    input: OrchestrationCreateCodeReviewWorkflowInput,
  }),
  Schema.Struct({
    templateId: Schema.Literal("builtin.investigation.dual"),
    templateVersion: Schema.optional(Schema.Literals([1, 2])),
    maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
    input: OrchestrationCreateInvestigationWorkflowInput,
  }),
]);
export type WorkflowPlatformCreateRunInput = typeof WorkflowPlatformCreateRunInput.Type;

export const WorkflowPlatformCreateRunResult = Schema.Struct({
  runKind: WorkflowRunKind,
  workflowId: TrimmedNonEmptyString,
});
export type WorkflowPlatformCreateRunResult = typeof WorkflowPlatformCreateRunResult.Type;

export const WorkflowPlatformInspectRunInput = Schema.Struct({
  runKind: WorkflowRunKind,
  workflowId: TrimmedNonEmptyString,
});
export type WorkflowPlatformInspectRunInput = typeof WorkflowPlatformInspectRunInput.Type;

export const WorkflowRunNodeStatus = Schema.Literals([
  "not_started",
  "pending",
  "running",
  "blocked",
  "manual_review",
  "completed",
  "skipped",
  "error",
]);
export type WorkflowRunNodeStatus = typeof WorkflowRunNodeStatus.Type;

export const WorkflowRunNodeInspection = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: WorkflowNodeKind,
  status: WorkflowRunNodeStatus,
  threadId: Schema.NullOr(ThreadId),
  slot: Schema.NullOr(WorkflowModelSlot),
  artifactType: Schema.NullOr(Schema.String),
  turnCostUsd: Schema.NullOr(Schema.Number),
  estimatedContextTokens: Schema.NullOr(NonNegativeInt),
  estimatedThinkingTokens: Schema.NullOr(NonNegativeInt),
  modelContextWindowTokens: Schema.NullOr(NonNegativeInt),
  sessionNotes: Schema.NullOr(ThreadSessionNotes),
  compactionInput: Schema.NullOr(ThreadCompaction),
});
export type WorkflowRunNodeInspection = typeof WorkflowRunNodeInspection.Type;

export const WorkflowRunInspection = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  templateId: WorkflowTemplateId,
  templateVersion: Schema.Int,
  runKind: WorkflowRunKind,
  status: TrimmedNonEmptyString,
  totalCostUsd: Schema.Number,
  maxCostUsd: Schema.NullOr(Schema.Number),
  budgetRemainingUsd: Schema.NullOr(Schema.Number),
  nodes: Schema.Array(WorkflowRunNodeInspection),
  projectMemories: Schema.Array(ProjectMemory),
  projectSkills: Schema.Array(ProjectSkill),
});
export type WorkflowRunInspection = typeof WorkflowRunInspection.Type;

export const WorkflowPlatformInspectRunResult = Schema.Struct({
  inspection: WorkflowRunInspection,
});
export type WorkflowPlatformInspectRunResult = typeof WorkflowPlatformInspectRunResult.Type;
