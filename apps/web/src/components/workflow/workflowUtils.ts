import type { PlanningWorkflow, ThreadId } from "@t3tools/contracts";
import { threadIdsForPlanningWorkflow } from "@t3tools/shared/workflowThreads";

export function threadIdsForWorkflow(workflow: PlanningWorkflow): ThreadId[] {
  return threadIdsForPlanningWorkflow(workflow);
}

export function workflowContainsThread(workflow: PlanningWorkflow, threadId: ThreadId): boolean {
  return threadIdsForWorkflow(workflow).includes(threadId);
}

export function workflowThreadDisplayTitle(
  workflow: PlanningWorkflow,
  threadTitle: string,
): string {
  const prefix = `${workflow.title} `;
  if (!threadTitle.startsWith(prefix)) {
    return threadTitle;
  }

  const trimmedTitle = threadTitle.slice(prefix.length).trim();
  return trimmedTitle.length > 0 ? trimmedTitle : threadTitle;
}

export function resolveApprovedMergedPlanMarkdown(
  workflow: PlanningWorkflow,
  mergeThread:
    | {
        readonly proposedPlans: ReadonlyArray<{
          readonly id: string;
          readonly planMarkdown: string;
        }>;
      }
    | null
    | undefined,
): string | null {
  if (!mergeThread) {
    return null;
  }
  if (workflow.merge.approvedPlanId) {
    const pinned = mergeThread.proposedPlans.find(
      (proposedPlan) => proposedPlan.id === workflow.merge.approvedPlanId,
    );
    if (pinned) {
      return pinned.planMarkdown;
    }
  }
  return mergeThread.proposedPlans.at(-1)?.planMarkdown ?? null;
}
