import { archivedWorkflowThreadIds } from "@t3tools/shared/workflowThreads";

import type {
  CodeReviewWorkflow,
  InvestigationWorkflow,
  PlanningWorkflow,
  Project,
  Thread,
} from "../types";

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

export function isSnoozedThread(thread: Pick<Thread, "snoozedUntil">, now = Date.now()): boolean {
  if (thread.snoozedUntil == null) return false;
  const timestamp = Date.parse(thread.snoozedUntil);
  return Number.isFinite(timestamp) && timestamp > now;
}

export function partitionThreadsBySnooze(
  threads: ReadonlyArray<Thread>,
  now = Date.now(),
): { readonly activeThreads: Thread[]; readonly snoozedThreads: Thread[] } {
  const activeThreads: Thread[] = [];
  const snoozedThreads: Thread[] = [];
  for (const thread of threads) {
    (isSnoozedThread(thread, now) ? snoozedThreads : activeThreads).push(thread);
  }
  return { activeThreads, snoozedThreads };
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
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): Thread[] {
  const hiddenWorkflowThreadIds = archivedWorkflowThreadIds(
    planningWorkflows,
    codeReviewWorkflows,
    investigationWorkflows,
  );
  return threads.filter(
    (thread) =>
      !isArchivedThread(thread) &&
      !isSnoozedThread(thread) &&
      !hiddenWorkflowThreadIds.has(thread.id),
  );
}

function buildMostRecentThreadByProjectId(
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): Map<Project["id"], Thread> {
  const mostRecentThreadByProjectId = new Map<Project["id"], Thread>();
  for (const thread of getVisibleThreads(
    threads,
    planningWorkflows,
    codeReviewWorkflows,
    investigationWorkflows,
  )) {
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
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): Thread | null {
  return (
    buildMostRecentThreadByProjectId(
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    ).get(projectId) ?? null
  );
}

export function compareProjectsByActivity(
  left: Project,
  right: Project,
  threads: ReadonlyArray<Thread>,
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): number {
  const leftLastInteractionAt =
    getMostRecentThreadForProject(
      left.id,
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    )?.lastInteractionAt ?? left.createdAt;
  const rightLastInteractionAt =
    getMostRecentThreadForProject(
      right.id,
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    )?.lastInteractionAt ?? right.createdAt;

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
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): Project[] {
  const mostRecentThreadByProjectId = buildMostRecentThreadByProjectId(
    threads,
    planningWorkflows,
    codeReviewWorkflows,
    investigationWorkflows,
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
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): Project | null {
  return (
    sortProjectsByActivity(
      projects,
      threads,
      planningWorkflows,
      codeReviewWorkflows,
      investigationWorkflows,
    )[0] ?? null
  );
}
