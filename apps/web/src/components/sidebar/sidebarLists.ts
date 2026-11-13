import {
  type CodeReviewWorkflowSummary as CodeReviewWorkflow,
  type CodeReviewWorkflowId,
  type GitStatusResult,
  type InvestigationWorkflowSummary as InvestigationWorkflow,
  type InvestigationWorkflowId,
  type PlanningWorkflowSummary as PlanningWorkflow,
  type PlanningWorkflowId,
  ThreadId,
} from "@t3tools/contracts";
import { partitionWorkflowsByArchive } from "@t3tools/shared/workflowArchive";

import type { DraftThreadState } from "../../composerDraftStore";
import {
  getProjectActiveThreadsWithPinnedDraft,
  getProjectThreadsWithDraft,
} from "../../lib/draftThreads";
import {
  isSnoozedThread,
  partitionThreadsByArchive,
  sortThreadsByActivity,
} from "../../lib/threadOrdering";
import {
  summarizeThreadPullRequestState,
  threadPullRequestStateColorClass,
  threadPullRequestTooltipLines,
  type ThreadPullRequestItem,
} from "../../lib/threadPullRequests";
import { workflowDisplayType } from "../../lib/workflowType";
import type { Project, Thread, ThreadListItem } from "../../types";
import { orderActiveSidebarThreads, projectSnoozedThreads } from "../Sidebar.pinSnooze.logic";
import { deriveCodeReviewTimelinePhases } from "../workflow/codeReviewWorkflowSidebarTimeline";
import { threadIdsForCodeReviewWorkflow } from "../workflow/codeReviewWorkflowUtils";
import { deriveInvestigationTimelinePhases } from "../workflow/investigationWorkflowSidebarTimeline";
import { threadIdsForInvestigationWorkflow } from "../workflow/investigationWorkflowUtils";
import { deriveTimelinePhases } from "../workflow/workflowSidebarTimeline";
import {
  currentStepFromPhases,
  overallStateFromPhases,
  phaseSummariesFromPhases,
  threadLabelsFromPhases,
  threadOrderFromPhases,
  type WorkflowCurrentStep,
  type WorkflowOverallState,
  type WorkflowPhaseSummary,
} from "../workflow/workflowTimelineTypes";
import { threadIdsForWorkflow } from "../workflow/workflowUtils";
import { workflowActivityAt } from "./sidebarWorkflowGroups";

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  /** The most actionable state across `items`: any open, else merged, else closed. */
  state: "open" | "closed" | "merged";
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  /** The top PR (open first, then newest). */
  url: string;
  number: number;
  /** Every PR of the thread, top first; never empty. */
  items: ReadonlyArray<ThreadPullRequestItem>;
}

export type ThreadPr = GitStatusResult["pr"];

export type SidebarWorkflowId = PlanningWorkflowId | CodeReviewWorkflowId | InvestigationWorkflowId;

export type SidebarWorkflowEntry =
  | {
      type: "planning";
      workflow: PlanningWorkflow;
    }
  | {
      type: "codeReview";
      workflow: CodeReviewWorkflow;
    }
  | {
      type: "investigation";
      workflow: InvestigationWorkflow;
    };

export type SidebarWorkflowType = SidebarWorkflowEntry["type"];

export type ArchivedSidebarItem =
  | {
      kind: "thread";
      key: string;
      sortAt: string;
      createdAt: string;
      thread: ThreadListItem;
    }
  | {
      kind: "workflow";
      key: string;
      sortAt: string;
      createdAt: string;
      type: SidebarWorkflowType;
      workflow: PlanningWorkflow | CodeReviewWorkflow | InvestigationWorkflow;
    };

export type SidebarProjectDraftThread = DraftThreadState & {
  threadId: ThreadId;
};

export interface SidebarWorkflowMeta {
  /** Role label per thread ("Branch A", "Merge"...). */
  threadLabels: ReadonlyMap<ThreadId, string>;
  overallState: WorkflowOverallState;
  /** Non-skipped phases, for the row's phase strip. */
  phases: readonly WorkflowPhaseSummary[];
  /** The step a collapsed row names on its second line. */
  currentStep: WorkflowCurrentStep | null;
  /** Thread ids in pipeline order (first appearance in the phases' steps). */
  threadOrder: readonly ThreadId[];
}

export interface ProjectSidebarLists<T extends ThreadListItem = ThreadListItem> {
  projectWorkflows: SidebarWorkflowEntry[];
  workflowThreadsByKey: Map<string, T[]>;
  workflowMetaByKey: Map<string, SidebarWorkflowMeta>;
  activeThreads: Array<T | Thread>;
  scheduledThreads: T[];
  snoozedThreads: T[];
  settledThreads: T[];
  archivedSidebarItems: ArchivedSidebarItem[];
  projectDraftThreadId: ThreadId | null;
}

export interface SidebarHoverFreezeSnapshot {
  workflowKeysByProjectId: Readonly<Record<string, readonly string[]>>;
  workflowThreadIdsByWorkflowKey: Readonly<Record<string, readonly ThreadId[]>>;
  activeThreadIdsByProjectId: Readonly<Record<string, readonly ThreadId[]>>;
  scheduledThreadIdsByProjectId: Readonly<Record<string, readonly ThreadId[]>>;
  archivedItemKeysByProjectId: Readonly<Record<string, readonly string[]>>;
  attentionThreadIds: readonly ThreadId[];
  /** The Recent view's item keys, in display order across its buckets. */
  recentItemKeys: readonly string[];
}

export function workflowEntryKey(entry: SidebarWorkflowEntry): string {
  return `${entry.type}:${entry.workflow.id}`;
}

export function buildProjectSidebarLists<T extends ThreadListItem>(input: {
  project: Project;
  threads: ReadonlyArray<T>;
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>;
  draftThread: SidebarProjectDraftThread | null;
}): ProjectSidebarLists<T> {
  const {
    project,
    threads,
    planningWorkflows,
    codeReviewWorkflows,
    investigationWorkflows,
    draftThread,
  } = input;
  const allProjectPlanningWorkflows = planningWorkflows.filter(
    (workflow) => workflow.projectId === project.id,
  );
  const allProjectCodeReviewWorkflows = codeReviewWorkflows.filter(
    (workflow) => workflow.projectId === project.id,
  );
  const allProjectInvestigationWorkflows = investigationWorkflows.filter(
    (workflow) => workflow.projectId === project.id,
  );
  const {
    activeWorkflows: activeProjectPlanningWorkflows,
    archivedWorkflows: archivedProjectPlanningWorkflows,
  } = partitionWorkflowsByArchive(allProjectPlanningWorkflows);
  const {
    activeWorkflows: activeProjectCodeReviewWorkflows,
    archivedWorkflows: archivedProjectCodeReviewWorkflows,
  } = partitionWorkflowsByArchive(allProjectCodeReviewWorkflows);
  const {
    activeWorkflows: activeProjectInvestigationWorkflows,
    archivedWorkflows: archivedProjectInvestigationWorkflows,
  } = partitionWorkflowsByArchive(allProjectInvestigationWorkflows);
  const unsortedProjectWorkflows: SidebarWorkflowEntry[] = [
    ...activeProjectPlanningWorkflows.map((workflow) => ({
      workflow,
      type: "planning" as const,
    })),
    ...activeProjectCodeReviewWorkflows.map((workflow) => ({
      workflow,
      type: "codeReview" as const,
    })),
    ...activeProjectInvestigationWorkflows.map((workflow) => ({
      workflow,
      type: "investigation" as const,
    })),
  ];
  const archivedProjectWorkflows = sortWorkflowEntriesByActivity([
    ...archivedProjectPlanningWorkflows.map((workflow) => ({
      workflow,
      type: "planning" as const,
    })),
    ...archivedProjectCodeReviewWorkflows.map((workflow) => ({
      workflow,
      type: "codeReview" as const,
    })),
    ...archivedProjectInvestigationWorkflows.map((workflow) => ({
      workflow,
      type: "investigation" as const,
    })),
  ]);

  const workflowThreadIds = new Set(
    allProjectPlanningWorkflows.flatMap((workflow) => threadIdsForWorkflow(workflow)),
  );
  for (const workflow of allProjectCodeReviewWorkflows) {
    for (const threadId of threadIdsForCodeReviewWorkflow(workflow)) {
      workflowThreadIds.add(threadId);
    }
  }
  for (const workflow of allProjectInvestigationWorkflows) {
    for (const threadId of threadIdsForInvestigationWorkflow(workflow)) {
      workflowThreadIds.add(threadId);
    }
  }

  const workflowMetaByKey = new Map(
    unsortedProjectWorkflows.map((entry) => [
      workflowEntryKey(entry),
      deriveSidebarWorkflowMeta(entry),
    ]),
  );

  const workflowThreadsByKey = new Map(
    unsortedProjectWorkflows.map((entry) => [
      workflowEntryKey(entry),
      orderThreadsByPipeline(
        workflowMetaByKey.get(workflowEntryKey(entry))?.threadOrder ?? [],
        threads.filter((thread) => {
          if (thread.projectId !== project.id) {
            return false;
          }
          if (isSnoozedThread(thread)) {
            return false;
          }
          if (entry.type === "planning") {
            return threadIdsForWorkflow(entry.workflow).includes(thread.id);
          }
          if (entry.type === "codeReview") {
            return threadIdsForCodeReviewWorkflow(entry.workflow).includes(thread.id);
          }
          return threadIdsForInvestigationWorkflow(entry.workflow).includes(thread.id);
        }),
      ),
    ]),
  );
  const projectWorkflows = sortWorkflowEntriesByActivity(
    unsortedProjectWorkflows,
    (entry) => workflowThreadsByKey.get(workflowEntryKey(entry)) ?? [],
  );

  const persistedProjectThreads = threads.filter(
    (thread) =>
      thread.projectId === project.id &&
      !workflowThreadIds.has(thread.id) &&
      !thread.scheduledOrigin,
  );
  const scheduledByActivity = sortThreadsByActivity(
    threads.filter(
      (thread) =>
        thread.projectId === project.id &&
        !workflowThreadIds.has(thread.id) &&
        thread.scheduledOrigin,
    ),
  );
  const scheduledThreads = [
    ...orderActiveSidebarThreads({
      threads: scheduledByActivity.filter((thread) => thread.archivedAt === null),
      draftThreadId: null,
    }),
    ...scheduledByActivity.filter(
      (thread) => thread.archivedAt === null && isSnoozedThread(thread),
    ),
    ...scheduledByActivity.filter((thread) => thread.archivedAt !== null),
  ];
  const projectThreads = getProjectThreadsWithDraft({
    projectId: project.id,
    projectThreads: persistedProjectThreads,
    draftThread,
    projectModel: project.model,
  });
  const { archivedThreads: unsortedArchivedThreads } = partitionThreadsByArchive(projectThreads);
  const activeThreads = getProjectActiveThreadsWithPinnedDraft({
    projectId: project.id,
    projectThreads: persistedProjectThreads,
    draftThread,
    projectModel: project.model,
  });
  const archivedThreads = sortThreadsByActivity(unsortedArchivedThreads);
  const archivedSidebarItems = sortArchivedSidebarItems([
    ...archivedProjectWorkflows.map((entry) => ({
      kind: "workflow" as const,
      key: `workflow:${entry.workflow.id}`,
      sortAt: entry.workflow.updatedAt,
      createdAt: entry.workflow.createdAt,
      type: entry.type,
      workflow: entry.workflow,
    })),
    ...archivedThreads.map((thread) => ({
      kind: "thread" as const,
      key: `thread:${thread.id}`,
      sortAt: thread.lastInteractionAt,
      createdAt: thread.createdAt,
      thread,
    })),
  ]);
  const projectDraftThreadId =
    draftThread && !persistedProjectThreads.some((thread) => thread.id === draftThread.threadId)
      ? draftThread.threadId
      : null;
  const orderedActiveThreads = orderActiveSidebarThreads({
    threads: activeThreads.filter((thread) => !thread.settledAt),
    draftThreadId: projectDraftThreadId,
  });
  const snoozedThreads = projectSnoozedThreads(
    threads.filter((thread) => !thread.settledAt && !thread.scheduledOrigin),
    project.id,
  );
  const settledThreads = sortThreadsByActivity(
    persistedProjectThreads.filter(
      (thread) =>
        thread.archivedAt === null &&
        !!thread.settledAt &&
        !thread.scheduledOrigin &&
        !thread.scheduledOrigin,
    ),
  );

  return {
    projectWorkflows,
    workflowThreadsByKey,
    workflowMetaByKey,
    activeThreads: orderedActiveThreads,
    scheduledThreads,
    snoozedThreads,
    settledThreads,
    archivedSidebarItems,
    projectDraftThreadId,
  };
}

export function deriveSidebarWorkflowMeta(entry: SidebarWorkflowEntry): SidebarWorkflowMeta {
  const phases =
    entry.type === "planning"
      ? deriveTimelinePhases(entry.workflow)
      : entry.type === "codeReview"
        ? deriveCodeReviewTimelinePhases(entry.workflow)
        : deriveInvestigationTimelinePhases(entry.workflow);
  return {
    threadLabels: threadLabelsFromPhases(phases),
    overallState: overallStateFromPhases(phases),
    phases: phaseSummariesFromPhases(phases),
    currentStep: currentStepFromPhases(phases),
    threadOrder: threadOrderFromPhases(phases),
  };
}

/**
 * A workflow's threads in pipeline order: those its phases name, in the order they first
 * appear, then any others by recent activity.
 */
export function orderThreadsByPipeline<T extends ThreadListItem>(
  threadOrder: readonly ThreadId[],
  threads: readonly T[],
): T[] {
  const indexById = new Map(threadOrder.map((threadId, index) => [threadId, index] as const));
  const ordered = threads
    .filter((thread) => indexById.has(thread.id))
    .toSorted((left, right) => indexById.get(left.id)! - indexById.get(right.id)!);
  const unmatched = sortThreadsByActivity(threads.filter((thread) => !indexById.has(thread.id)));
  return [...ordered, ...unmatched];
}

/**
 * Newest activity first. Active workflows go by their threads' activity (`threadsOf`), since
 * `updatedAt` moves on bookkeeping writes; archived ones, listed without threads, by `updatedAt`.
 */
function sortWorkflowEntriesByActivity(
  workflows: ReadonlyArray<SidebarWorkflowEntry>,
  threadsOf?: (entry: SidebarWorkflowEntry) => ReadonlyArray<ThreadListItem>,
): SidebarWorkflowEntry[] {
  const activityAt = new Map(
    workflows.map((entry) => [
      entry,
      threadsOf ? workflowActivityAt(entry.workflow, threadsOf(entry)) : entry.workflow.updatedAt,
    ]),
  );
  return workflows.toSorted(
    (left, right) =>
      activityAt.get(right)!.localeCompare(activityAt.get(left)!) ||
      right.workflow.id.localeCompare(left.workflow.id),
  );
}

function sortArchivedSidebarItems(
  items: ReadonlyArray<ArchivedSidebarItem>,
): ArchivedSidebarItem[] {
  return items.toSorted(
    (left, right) =>
      right.sortAt.localeCompare(left.sortAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.key.localeCompare(left.key),
  );
}

export function isWorkflowRouteActive(
  pathname: string,
  workflowId: SidebarWorkflowId,
  type: SidebarWorkflowType,
): boolean {
  if (type === "planning") {
    return pathname === `/workflow/${workflowId}` || pathname === `/_chat/workflow/${workflowId}`;
  }
  if (type === "codeReview") {
    return (
      pathname === `/code-review/${workflowId}` || pathname === `/_chat/code-review/${workflowId}`
    );
  }
  return (
    pathname === `/investigation/${workflowId}` || pathname === `/_chat/investigation/${workflowId}`
  );
}

export function workflowRouteForType(type: SidebarWorkflowType) {
  switch (type) {
    case "planning":
      return "/workflow/$workflowId" as const;
    case "codeReview":
      return "/code-review/$workflowId" as const;
    case "investigation":
      return "/investigation/$workflowId" as const;
  }
}

export function workflowTypeLabel(
  type: SidebarWorkflowType,
  workflow: SidebarWorkflowEntry["workflow"],
): string {
  if (workflowDisplayType(type, workflow) === "document") return "Document";
  switch (type) {
    case "planning":
      return "Feature";
    case "codeReview":
      return "Review";
    case "investigation":
      return "Investigation";
  }
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-info-foreground",
    pulse: true,
  };
}

const PR_STATE_LABEL = {
  open: "PR open",
  merged: "PR merged",
  closed: "PR closed",
} as const satisfies Record<PrStatusIndicator["state"], PrStatusIndicator["label"]>;

/** One indicator for all of a thread's PRs, colored by the most actionable state. */
export function prStatusIndicator(
  items: ReadonlyArray<ThreadPullRequestItem>,
): PrStatusIndicator | null {
  const top = items[0];
  const state = summarizeThreadPullRequestState(items);
  if (!top || !state) return null;
  const label = PR_STATE_LABEL[state];
  return {
    state,
    label,
    colorClass: threadPullRequestStateColorClass(state),
    tooltip:
      items.length === 1
        ? `#${top.number} ${label}: ${top.title}`
        : threadPullRequestTooltipLines(items).join("\n"),
    url: top.url,
    number: top.number,
    items,
  };
}

/** A finished workflow's PR status tooltip: "PR #462 open", "Merged #462" or "PR #462 closed". */
export function workflowPrLabel(pr: PrStatusIndicator): string {
  switch (pr.state) {
    case "open":
      return `PR #${pr.number} open`;
    case "merged":
      return `Merged #${pr.number}`;
    case "closed":
      return `PR #${pr.number} closed`;
  }
}

const PINNED_THREAD_SORTABLE_PREFIX = "pinned-thread:";

export function pinnedThreadSortableId(threadId: ThreadId): string {
  return `${PINNED_THREAD_SORTABLE_PREFIX}${threadId}`;
}

export function threadIdFromPinnedSortableId(id: string | number): ThreadId | null {
  const value = String(id);
  return value.startsWith(PINNED_THREAD_SORTABLE_PREFIX)
    ? ThreadId.makeUnsafe(value.slice(PINNED_THREAD_SORTABLE_PREFIX.length))
    : null;
}
