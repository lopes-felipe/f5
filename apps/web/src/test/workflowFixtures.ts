import {
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type PlanningWorkflow,
  type DocumentReaderPass,
  type ProjectId as ProjectIdType,
} from "@t3tools/contracts";

export interface CreatePlanningWorkflowOptions {
  templateId?: string;
  templateVersion?: number;
  documentType?: PlanningWorkflow["documentType"];
  readerReviewEnabled?: boolean;
  readerPersona?: string | null;
  readerSlot?: PlanningWorkflow["readerSlot"];
  readerPass?: PlanningWorkflow["readerPass"];
  id?: string;
  projectId?: ProjectIdType;
  now?: string;
  title?: string;
  slug?: string;
  requirementPrompt?: string;
  plansDirectory?: string;
  selfReviewEnabled?: boolean;
  branchAThreadId?: ThreadId;
  branchBThreadId?: ThreadId;
  branchA?: Partial<PlanningWorkflow["branchA"]>;
  branchB?: Partial<PlanningWorkflow["branchB"]>;
  merge?: Partial<PlanningWorkflow["merge"]>;
  implementation?: PlanningWorkflow["implementation"];
  totalCostUsd?: number;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

export function createPlanningWorkflow(
  overrides: CreatePlanningWorkflowOptions = {},
): OrchestrationReadModel["planningWorkflows"][number] {
  const now = overrides.now ?? "2026-03-11T12:00:00.000Z";
  const projectId = overrides.projectId ?? ProjectId.makeUnsafe("project-1");
  const branchAThreadId = overrides.branchAThreadId ?? ThreadId.makeUnsafe("workflow-branch-a");
  const branchBThreadId = overrides.branchBThreadId ?? ThreadId.makeUnsafe("workflow-branch-b");

  return {
    templateId: overrides.templateId,
    templateVersion: overrides.templateVersion,
    documentType: overrides.documentType,
    readerReviewEnabled: overrides.readerReviewEnabled,
    readerPersona: overrides.readerPersona,
    readerSlot: overrides.readerSlot,
    readerPass: overrides.readerPass,
    id: PlanningWorkflowId.makeUnsafe(overrides.id ?? "workflow-1"),
    projectId,
    title: overrides.title ?? "Workflow status test",
    slug: overrides.slug ?? "workflow-status-test",
    requirementPrompt: overrides.requirementPrompt ?? "Implement workflow status pills.",
    plansDirectory: overrides.plansDirectory ?? "plans",
    selfReviewEnabled: overrides.selfReviewEnabled ?? true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5" },
      authorThreadId: branchAThreadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "authoring",
      error: null,
      errorStage: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
      ...overrides.branchA,
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "codex", model: "gpt-5" },
      authorThreadId: branchBThreadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      errorStage: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
      ...overrides.branchB,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: now,
      ...overrides.merge,
    },
    implementation: overrides.implementation ?? null,
    totalCostUsd: overrides.totalCostUsd ?? 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
  };
}

export function createDocumentReaderPass(
  overrides: Partial<DocumentReaderPass> = {},
): DocumentReaderPass {
  return {
    status: "reader_running",
    error: null,
    errorStage: null,
    draftTurnId: "merge-turn",
    draftPlanId: "draft-plan",
    readerThreadId: ThreadId.makeUnsafe("reader-thread"),
    readerStartedAt: "2026-03-11T12:00:00.000Z",
    pinnedTurnId: null,
    pinnedAssistantMessageId: null,
    polishRequestedAt: null,
    polishTurnId: null,
    polishFormatRepairAttempts: 0,
    retryCount: 0,
    lastRetryAt: null,
    updatedAt: "2026-03-11T12:00:00.000Z",
    ...overrides,
  };
}
