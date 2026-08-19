import type {
  CodeReviewWorkflow,
  CodeReviewWorkflowId,
  InvestigationWorkflow,
  InvestigationWorkflowId,
  PlanningWorkflow,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  WorkflowModelSlot,
} from "@t3tools/contracts";

function slotLabel(slot: WorkflowModelSlot): string {
  return `${slot.provider}:${slot.model}`;
}

interface VersionedRecordInput {
  readonly templateId: string;
  readonly templateVersion: number;
}

export function buildPlanningWorkflowRecord(
  input: VersionedRecordInput & {
    readonly workflowId: PlanningWorkflowId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly slug: string;
    readonly requirementPrompt: string;
    readonly plansDirectory: string;
    readonly selfReviewEnabled: boolean;
    readonly authorThreadIdA: ThreadId;
    readonly authorThreadIdB: ThreadId;
    readonly branchA: WorkflowModelSlot;
    readonly branchB: WorkflowModelSlot;
    readonly merge: WorkflowModelSlot;
    readonly maxCostUsd?: number | undefined;
    readonly createdAt: string;
  },
): PlanningWorkflow {
  const branch = (
    branchId: "a" | "b",
    authorSlot: WorkflowModelSlot,
    authorThreadId: ThreadId,
  ): PlanningWorkflow["branchA"] => ({
    branchId,
    authorSlot,
    authorThreadId,
    planFilePath: null,
    planTurnId: null,
    revisionTurnId: null,
    reviews: [],
    status: "pending",
    error: null,
    errorStage: null,
    retryCount: 0,
    authorFormatRepairAttempts: 0,
    revisionFormatRepairAttempts: 0,
    lastRetryAt: null,
    updatedAt: input.createdAt,
  });
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    requirementPrompt: input.requirementPrompt,
    plansDirectory: input.plansDirectory,
    selfReviewEnabled: input.selfReviewEnabled,
    branchA: branch("a", input.branchA, input.authorThreadIdA),
    branchB: branch("b", input.branchB, input.authorThreadIdB),
    merge: {
      mergeSlot: input.merge,
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      formatRepairAttempts: 0,
      updatedAt: input.createdAt,
    },
    implementation: null,
    totalCostUsd: 0,
    maxCostUsd: input.maxCostUsd ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  };
}

export function buildCodeReviewWorkflowRecord(
  input: VersionedRecordInput & {
    readonly workflowId: CodeReviewWorkflowId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly slug: string;
    readonly reviewPrompt: string;
    readonly branch: string | null;
    readonly reviewThreadIdA: ThreadId;
    readonly reviewThreadIdB: ThreadId;
    readonly reviewerA: WorkflowModelSlot;
    readonly reviewerB: WorkflowModelSlot;
    readonly consolidation: WorkflowModelSlot;
    readonly maxCostUsd?: number | undefined;
    readonly createdAt: string;
  },
): CodeReviewWorkflow {
  const reviewer = (
    label: "Reviewer A" | "Reviewer B",
    slot: WorkflowModelSlot,
    threadId: ThreadId,
  ): CodeReviewWorkflow["reviewerA"] => ({
    label: `${label} (${slotLabel(slot)})`,
    slot,
    threadId,
    status: "pending",
    pinnedTurnId: null,
    pinnedAssistantMessageId: null,
    error: null,
    retryCount: 0,
    updatedAt: input.createdAt,
  });
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    reviewPrompt: input.reviewPrompt,
    branch: input.branch,
    reviewerA: reviewer("Reviewer A", input.reviewerA, input.reviewThreadIdA),
    reviewerB: reviewer("Reviewer B", input.reviewerB, input.reviewThreadIdB),
    consolidation: {
      slot: input.consolidation,
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      updatedAt: input.createdAt,
    },
    totalCostUsd: 0,
    maxCostUsd: input.maxCostUsd ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  };
}

export function buildInvestigationWorkflowRecord(
  input: VersionedRecordInput & {
    readonly workflowId: InvestigationWorkflowId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly slug: string;
    readonly problemPrompt: string;
    readonly branch: string | null;
    readonly selfReviewEnabled: boolean;
    readonly investigationThreadIdA: ThreadId;
    readonly investigationThreadIdB: ThreadId;
    readonly investigatorA: WorkflowModelSlot;
    readonly investigatorB: WorkflowModelSlot;
    readonly synthesis: WorkflowModelSlot;
    readonly maxCostUsd?: number | undefined;
    readonly createdAt: string;
  },
): InvestigationWorkflow {
  const investigator = (
    label: "Investigator A" | "Investigator B",
    slot: WorkflowModelSlot,
    investigationThreadId: ThreadId,
  ): InvestigationWorkflow["investigatorA"] => ({
    label: `${label} (${slotLabel(slot)})`,
    slot,
    investigationThreadId,
    investigationStatus: "pending",
    investigationTurnId: null,
    investigationMessageId: null,
    crossReviewThreadId: null,
    crossReviewStatus: "not_started",
    crossReviewTurnId: null,
    crossReviewMessageId: null,
    selfReviewThreadId: null,
    selfReviewStatus: "not_started",
    selfReviewTurnId: null,
    selfReviewMessageId: null,
    error: null,
    investigationRetryCount: 0,
    crossReviewRetryCount: 0,
    selfReviewRetryCount: 0,
    updatedAt: input.createdAt,
  });
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    problemPrompt: input.problemPrompt,
    branch: input.branch,
    selfReviewEnabled: input.selfReviewEnabled,
    investigatorA: investigator(
      "Investigator A",
      input.investigatorA,
      input.investigationThreadIdA,
    ),
    investigatorB: investigator(
      "Investigator B",
      input.investigatorB,
      input.investigationThreadIdB,
    ),
    synthesis: {
      slot: input.synthesis,
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      updatedAt: input.createdAt,
    },
    totalCostUsd: 0,
    maxCostUsd: input.maxCostUsd ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  };
}
