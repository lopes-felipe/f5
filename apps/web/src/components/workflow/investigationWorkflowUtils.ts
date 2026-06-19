import type { InvestigationWorkflow, ThreadId } from "@t3tools/contracts";
import { threadIdsForInvestigationWorkflow as getInvestigationWorkflowThreadIds } from "@t3tools/shared/workflowThreads";

export function threadIdsForInvestigationWorkflow(workflow: InvestigationWorkflow): ThreadId[] {
  return getInvestigationWorkflowThreadIds(workflow);
}

export function investigationWorkflowContainsThread(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): boolean {
  return threadIdsForInvestigationWorkflow(workflow).includes(threadId);
}
