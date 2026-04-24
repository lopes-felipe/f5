import { archivedWorkflowThreadIds } from "@t3tools/shared/workflowThreads";

import type { CodeReviewWorkflow, PlanningWorkflow, Project, Thread } from "../types";

function compareIsoDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

export function compareThreadsByActivity(left: Thread, right: Thread): number {
  return (
    compareIsoDescending(left.lastInteractionAt, right.lastInteractionAt) ||
    compareIsoDescending(left.createdAt, right.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

export function sortThreadsByActivity(threads: ReadonlyArray<Thread>): Thread[] {
  return threads.toSorted(compareThreadsByActivity);
}

export function isArchivedThread(thread: Pick<Thread, "archivedAt">): boolean {
  return thread.archivedAt !== null;
}

export function partitionThreadsByArchive(threads: ReadonlyArray<Thread>): {
  readonly activeThreads: Thread[];
  readonly archivedThreads: Thread[];
} {
  const activeThreads: Thread[] = [];
  const archivedThreads: Thread[] = [];

  for (const thread of threads) {
    if (isArchivedThread(thread)) {
      archivedThreads.push(thread);
    } else {
      activeThreads.push(thread);
    }
  }

  return { activeThreads, archivedThreads };
}

export function getVisibleThreads(
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Thread[] {
  const hiddenWorkflowThreadIds = archivedWorkflowThreadIds(planningWorkflows, codeReviewWorkflows);
  return threads.filter(
    (thread) => !isArchivedThread(thread) && !hiddenWorkflowThreadIds.has(thread.id),
  );
}

function buildMostRecentThreadByProjectId(
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Map<Project["id"], Thread> {
  const mostRecentThreadByProjectId = new Map<Project["id"], Thread>();
  for (const thread of getVisibleThreads(threads, planningWorkflows, codeReviewWorkflows)) {
    const current = mostRecentThreadByProjectId.get(thread.projectId);
    if (!current || compareThreadsByActivity(thread, current) < 0) {
      mostRecentThreadByProjectId.set(thread.projectId, thread);
    }
  }
  return mostRecentThreadByProjectId;
}

export function getMostRecentThreadForProject(
  projectId: Project["id"],
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Thread | null {
  return (
    buildMostRecentThreadByProjectId(threads, planningWorkflows, codeReviewWorkflows).get(
      projectId,
    ) ?? null
  );
}

export function compareProjectsByActivity(
  left: Project,
  right: Project,
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): number {
  const leftLastInteractionAt =
    getMostRecentThreadForProject(left.id, threads, planningWorkflows, codeReviewWorkflows)
      ?.lastInteractionAt ?? left.createdAt;
  const rightLastInteractionAt =
    getMostRecentThreadForProject(right.id, threads, planningWorkflows, codeReviewWorkflows)
      ?.lastInteractionAt ?? right.createdAt;

  return (
    compareIsoDescending(leftLastInteractionAt, rightLastInteractionAt) ||
    compareIsoDescending(left.createdAt, right.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

export function sortProjectsByActivity(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Project[] {
  const mostRecentThreadByProjectId = buildMostRecentThreadByProjectId(
    threads,
    planningWorkflows,
    codeReviewWorkflows,
  );
  return projects.toSorted((left, right) => {
    const leftLastInteractionAt =
      mostRecentThreadByProjectId.get(left.id)?.lastInteractionAt ?? left.createdAt;
    const rightLastInteractionAt =
      mostRecentThreadByProjectId.get(right.id)?.lastInteractionAt ?? right.createdAt;

    return (
      compareIsoDescending(leftLastInteractionAt, rightLastInteractionAt) ||
      compareIsoDescending(left.createdAt, right.createdAt) ||
      right.id.localeCompare(left.id)
    );
  });
}

export function getMostRecentProject(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Project | null {
  return (
    sortProjectsByActivity(projects, threads, planningWorkflows, codeReviewWorkflows)[0] ?? null
  );
}
