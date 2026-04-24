import type { CodeReviewWorkflow, ThreadId } from "@t3tools/contracts";
import { threadIdsForCodeReviewWorkflow as getCodeReviewWorkflowThreadIds } from "@t3tools/shared/workflowThreads";

export function threadIdsForCodeReviewWorkflow(workflow: CodeReviewWorkflow): ThreadId[] {
  return getCodeReviewWorkflowThreadIds(workflow);
}

export function codeReviewWorkflowContainsThread(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
): boolean {
  return threadIdsForCodeReviewWorkflow(workflow).includes(threadId);
}
