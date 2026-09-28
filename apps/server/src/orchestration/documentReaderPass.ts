import type { DocumentReaderPass, PlanningWorkflow, ThreadId } from "@t3tools/contracts";
function update(
  workflow: PlanningWorkflow,
  patch: Partial<DocumentReaderPass>,
  updatedAt: string,
): PlanningWorkflow {
  if (!workflow.readerPass) throw new Error("Document reader pass has not been initialized.");
  return { ...workflow, readerPass: { ...workflow.readerPass, ...patch, updatedAt }, updatedAt };
}
export function markDocumentMergeDrafted(
  workflow: PlanningWorkflow,
  input: { turnId: string; draftPlanId: string; readerThreadId: ThreadId; updatedAt: string },
): PlanningWorkflow {
  return {
    ...workflow,
    merge: {
      ...workflow.merge,
      status: "merged",
      turnId: input.turnId,
      approvedPlanId: null,
      error: null,
      updatedAt: input.updatedAt,
    },
    readerPass: {
      status: "reader_requested",
      errorStage: null,
      error: null,
      draftTurnId: input.turnId,
      draftPlanId: input.draftPlanId,
      readerThreadId: input.readerThreadId,
      readerStartedAt: null,
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      polishRequestedAt: null,
      polishTurnId: null,
      polishFormatRepairAttempts: 0,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}
export function markReaderRunning(workflow: PlanningWorkflow, updatedAt: string): PlanningWorkflow {
  return update(
    workflow,
    { status: "reader_running", readerStartedAt: updatedAt, error: null, errorStage: null },
    updatedAt,
  );
}
export function markReaderSaved(
  workflow: PlanningWorkflow,
  input: { turnId: string; messageId: string | null; updatedAt: string },
): PlanningWorkflow {
  return update(
    workflow,
    {
      status: "reader_saved",
      pinnedTurnId: input.turnId,
      pinnedAssistantMessageId: input.messageId,
      error: null,
      errorStage: null,
    },
    input.updatedAt,
  );
}
export function markPolishRequested(
  workflow: PlanningWorkflow,
  updatedAt: string,
): PlanningWorkflow {
  return update(
    workflow,
    { status: "polishing", polishRequestedAt: updatedAt, error: null, errorStage: null },
    updatedAt,
  );
}
export function markPolishCompleted(
  workflow: PlanningWorkflow,
  input: { turnId: string; planId: string; updatedAt: string },
): PlanningWorkflow {
  const next = update(
    workflow,
    { status: "completed", polishTurnId: input.turnId, error: null, errorStage: null },
    input.updatedAt,
  );
  return {
    ...next,
    merge: {
      ...next.merge,
      status: "manual_review",
      turnId: input.turnId,
      approvedPlanId: input.planId,
      error: null,
      updatedAt: input.updatedAt,
    },
  };
}
export function markReaderPassError(
  workflow: PlanningWorkflow,
  stage: "reader" | "polish",
  error: string,
  updatedAt: string,
): PlanningWorkflow {
  return update(workflow, { status: "error", errorStage: stage, error }, updatedAt);
}
export function markReaderPassSkipped(
  workflow: PlanningWorkflow,
  updatedAt: string,
): PlanningWorkflow {
  const next = update(workflow, { status: "skipped", error: null, errorStage: null }, updatedAt);
  return {
    ...next,
    merge: {
      ...next.merge,
      status: "manual_review",
      approvedPlanId: next.readerPass!.draftPlanId,
      turnId: next.readerPass!.draftTurnId,
      error: null,
      updatedAt,
    },
  };
}
