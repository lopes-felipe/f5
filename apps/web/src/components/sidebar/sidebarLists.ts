import {
  type CodeReviewWorkflow,
  type CodeReviewWorkflowId,
  type GitStatusResult,
  type InvestigationWorkflow,
  type InvestigationWorkflowId,
  type PlanningWorkflow,
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
import { workflowDisplayType } from "../../lib/workflowType";
import type { Project, Thread } from "../../types";
import { orderActiveSidebarThreads, projectSnoozedThreads } from "../Sidebar.pinSnooze.logic";
import { deriveCodeReviewTimelinePhases } from "../workflow/codeReviewWorkflowSidebarTimeline";
import { threadIdsForCodeReviewWorkflow } from "../workflow/codeReviewWorkflowUtils";
import { deriveInvestigationTimelinePhases } from "../workflow/investigationWorkflowSidebarTimeline";
import { threadIdsForInvestigationWorkflow } from "../workflow/investigationWorkflowUtils";
import { deriveTimelinePhases } from "../workflow/workflowSidebarTimeline";
import {
  overallStateFromPhases,
  threadLabelsFromPhases,
  type WorkflowOverallState,
} from "../workflow/workflowTimelineTypes";
import { threadIdsForWorkflow } from "../workflow/workflowUtils";

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
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
      thread: Thread;
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
}

export interface ProjectSidebarLists {
  projectWorkflows: SidebarWorkflowEntry[];
  workflowThreadsByKey: Map<string, Thread[]>;
  workflowMetaByKey: Map<string, SidebarWorkflowMeta>;
  activeThreads: Thread[];
  snoozedThreads: Thread[];
  archivedSidebarItems: ArchivedSidebarItem[];
  projectDraftThreadId: ThreadId | null;
}

export interface SidebarHoverFreezeSnapshot {
  workflowKeysByProjectId: Readonly<Record<string, readonly string[]>>;
  workflowThreadIdsByWorkflowKey: Readonly<Record<string, readonly ThreadId[]>>;
  activeThreadIdsByProjectId: Readonly<Record<string, readonly ThreadId[]>>;
  archivedItemKeysByProjectId: Readonly<Record<string, readonly string[]>>;
  attentionThreadIds: readonly ThreadId[];
}

export function workflowEntryKey(entry: SidebarWorkflowEntry): string {
  return `${entry.type}:${entry.workflow.id}`;
}

export function buildProjectSidebarLists(input: {
  project: Project;
  threads: ReadonlyArray<Thread>;
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>;
  draftThread: SidebarProjectDraftThread | null;
}): ProjectSidebarLists {
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
  const projectWorkflows = sortWorkflowEntriesByActivity([
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
  ]);
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

  const workflowThreadsByKey = new Map(
    projectWorkflows.map((entry) => [
      workflowEntryKey(entry),
      sortThreadsByActivity(
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

  const workflowMetaByKey = new Map(
    projectWorkflows.map((entry) => [workflowEntryKey(entry), deriveSidebarWorkflowMeta(entry)]),
  );

  const persistedProjectThreads = threads.filter(
    (thread) => thread.projectId === project.id && !workflowThreadIds.has(thread.id),
  );
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
    threads: activeThreads,
    draftThreadId: projectDraftThreadId,
  });
  const snoozedThreads = projectSnoozedThreads(threads, project.id);

  return {
    projectWorkflows,
    workflowThreadsByKey,
    workflowMetaByKey,
    activeThreads: orderedActiveThreads,
    snoozedThreads,
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
  };
}

function sortWorkflowEntriesByActivity(
  workflows: ReadonlyArray<SidebarWorkflowEntry>,
): SidebarWorkflowEntry[] {
  return workflows.toSorted(
    (left, right) =>
      right.workflow.updatedAt.localeCompare(left.workflow.updatedAt) ||
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

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-success-foreground",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-muted-foreground",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-attention-foreground",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
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
