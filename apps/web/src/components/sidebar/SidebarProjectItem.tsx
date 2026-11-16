import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRightIcon, EllipsisIcon, SquarePenIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { DraftThreadState } from "../../composerDraftStore";
import { getVisibleThreadsWithPinnedDraft, isDraftThreadId } from "../../lib/draftThreads";
import { cn } from "../../lib/utils";
import type { ThreadSummary } from "../../threadSelectors";
import type { Project } from "../../types";
import { InlineTitleEditor } from "../InlineTitleEditor";
import { ProjectIcon } from "../ProjectIcon";
import {
  partitionAgedSidebarItems,
  reconcileFrozenOrder,
  SIDEBAR_TREE_LEVEL_CLASS_NAME,
  type SidebarShelfBucket,
  type SidebarThreadBucket,
  threadBucketExpansionKey,
} from "../Sidebar.logic";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuSub } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Kbd } from "../ui/kbd";
import {
  type ProjectSidebarLists,
  type SidebarHoverFreezeSnapshot,
  type SidebarWorkflowEntry,
  type SidebarWorkflowId,
  type SidebarWorkflowType,
  isWorkflowRouteActive,
  pinnedThreadSortableId,
  workflowEntryKey,
} from "./sidebarLists";
import { liveSidebarActivityAt } from "./sidebarRecent";
import { workflowActivityAt } from "./sidebarWorkflowGroups";
import { SidebarThreadRow } from "./SidebarThreadRow";
import {
  ScheduledShelfIndicator,
  SidebarScheduledShelfList,
  summarizeScheduledThreads,
  useScheduledFolderMenu,
} from "./SidebarScheduledFolder";
import { ListToggleRow, MoreAndOlderRow } from "./SidebarSectionRows";
import { SidebarShelfRow, type SidebarShelfSegment } from "./SidebarShelfRow";
import { SidebarTreeParentContext, sidebarProjectRowId } from "./sidebarTreeRow";
import {
  SidebarArchivedWorkflowRow,
  SidebarWorkflowItem,
  type SidebarIndicatorsForThread,
} from "./SidebarWorkflowItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";

type SortableProjectHandleProps = Partial<
  Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">
>;

function ProjectItemWrapper(props: {
  project: Project;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  if (isScratchProject(props.project)) {
    return (
      <li
        className="group/menu-item relative rounded-lg"
        data-sidebar="menu-item"
        data-slot="sidebar-menu-item"
      >
        {props.children({})}
      </li>
    );
  }
  return <SortableProjectItem projectId={props.project.id}>{props.children}</SortableProjectItem>;
}

function SortableProjectItem({
  projectId,
  children,
}: {
  projectId: ProjectId;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: projectId });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "group/menu-item relative rounded-lg",
        isDragging && "z-20 opacity-80",
        isOver && !isDragging && "ring-1 ring-primary/40",
      )}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners })}
    </li>
  );
}

/** Project-level callbacks owned by the sidebar container. */
export interface SidebarProjectActions {
  onTitlePointerDownCapture: () => void;
  onTitleClick: (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  onTitleKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  onContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  onCommitRename: (projectId: ProjectId, value: string, originalTitle: string) => void;
  onCancelRename: () => void;
  onCreateWorkflow: (projectId: ProjectId) => void;
  onToggleWorkflowCollapsed: (workflowId: string, fallbackExpanded: boolean) => void;
  onArchiveWorkflow: (
    workflowId: SidebarWorkflowId,
    title: string,
    type: SidebarWorkflowType,
  ) => void;
  onUnarchiveWorkflow: (workflowId: SidebarWorkflowId, type: SidebarWorkflowType) => void;
  onExpandThreadList: (projectId: ProjectId, bucket: SidebarThreadBucket) => void;
  onCollapseThreadList: (projectId: ProjectId, bucket: SidebarThreadBucket) => void;
  onToggleShelfBucket: (projectId: ProjectId, bucket: SidebarShelfBucket) => void;
  onPinnedThreadDragEnd: (event: DragEndEvent) => void;
}

export interface SidebarProjectItemProps {
  project: Project;
  sidebarLists: ProjectSidebarLists<ThreadSummary>;
  freezeSnapshot: SidebarHoverFreezeSnapshot | null;
  threadPreviewLimit: number;
  /** Expansion keys (`threadBucketExpansionKey`) of every project's lists. */
  expandedThreadLists: ReadonlySet<string>;
  openShelfBucket: SidebarShelfBucket | null;
  /** Days idle before a thread folds into "N older"; 0 keeps the preview count instead. */
  olderThreadDays: number;
  /** The clock aging compares against (floored to the hour). */
  now: number;
  /** Live activity hours by thread id (`useLiveActivityHours`); summary times can lag. */
  liveActivityHours: Readonly<Record<string, number>>;
  /** Threads that never fold: the open one, unread, running, waiting on the user, live terminals. */
  agingExemptThreadIds: ReadonlySet<ThreadId>;
  draftThreadsByThreadId: Readonly<Record<ThreadId, DraftThreadState>>;
  persistedThreadIds: ReadonlySet<ThreadId>;
  routeThreadId: ThreadId | null;
  pathname: string;
  isRenamingProject: boolean;
  expandWorkflowThreadsByDefault: boolean;
  workflowExpandedById: Readonly<Record<string, boolean>>;
  newThreadShortcutLabel: string | null;
  workflowShortcutLabel: string | null;
  dndSensors: SensorDescriptor<SensorOptions>[];
  collisionDetection: CollisionDetection;
  indicatorsForThread: SidebarIndicatorsForThread;
  threadActions: SidebarThreadActions;
  projectActions: SidebarProjectActions;
}

/** Statuses counted on a collapsed project header. */
const ACTIVE_STATUS_LABELS = new Set([
  "Working",
  "Connecting",
  "Pending Approval",
  "Awaiting Input",
  "Plan Ready",
]);

const PROJECT_ACTION_CLASS_NAME =
  "top-1 size-6 rounded-md p-0 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The 6px gap between a project's workflows and its threads. */
function GroupGapRow() {
  return <li aria-hidden="true" className="h-1.5 shrink-0" />;
}

export function SidebarProjectItem(props: SidebarProjectItemProps) {
  "use memo";
  const {
    project,
    sidebarLists,
    freezeSnapshot,
    threadPreviewLimit,
    expandedThreadLists,
    openShelfBucket,
    olderThreadDays,
    draftThreadsByThreadId,
    persistedThreadIds,
    routeThreadId,
    pathname,
    indicatorsForThread,
    threadActions,
    projectActions,
  } = props;

  const projectWorkflows = reconcileFrozenOrder({
    items: sidebarLists.projectWorkflows,
    getKey: workflowEntryKey,
    frozenOrder: freezeSnapshot?.workflowKeysByProjectId[project.id],
  });
  const workflowThreadsByWorkflowId = new Map(
    projectWorkflows.map((entry) => {
      const workflowKey = workflowEntryKey(entry);
      const workflowThreads = reconcileFrozenOrder({
        items: sidebarLists.workflowThreadsByKey.get(workflowKey) ?? [],
        getKey: (thread) => thread.id,
        frozenOrder: freezeSnapshot?.workflowThreadIdsByWorkflowKey[workflowKey],
      });
      return [entry.workflow.id, workflowThreads] as const;
    }),
  );
  const activeThreads = reconcileFrozenOrder({
    items: sidebarLists.activeThreads,
    getKey: (thread) => thread.id,
    frozenOrder: freezeSnapshot?.activeThreadIdsByProjectId[project.id],
    prependUnseenKeys: sidebarLists.projectDraftThreadId ? [sidebarLists.projectDraftThreadId] : [],
  });
  const snoozedThreads = sidebarLists.snoozedThreads;
  const scheduledThreads = reconcileFrozenOrder({
    items: sidebarLists.scheduledThreads,
    getKey: (thread) => thread.id,
    frozenOrder: freezeSnapshot?.scheduledThreadIdsByProjectId[project.id],
  });
  const currentScheduledThreads = scheduledThreads.filter((thread) => thread.archivedAt === null);
  const archivedScheduledThreads = scheduledThreads.filter((thread) => thread.archivedAt !== null);
  const selectedArchivedScheduledThread = archivedScheduledThreads.some(
    (thread) => thread.id === routeThreadId,
  );
  const isListExpanded = (bucket: SidebarThreadBucket) =>
    expandedThreadLists.has(threadBucketExpansionKey(project.id, bucket));
  const toggleList = (bucket: SidebarThreadBucket) => {
    if (isListExpanded(bucket)) projectActions.onCollapseThreadList(project.id, bucket);
    else projectActions.onExpandThreadList(project.id, bucket);
  };
  const scheduledExpanded = openShelfBucket === "scheduled";
  const [scheduledShowingAll, setScheduledShowingAll] = useState(false);
  const [scheduledArchivedExpanded, setScheduledArchivedExpanded] = useState(
    selectedArchivedScheduledThread,
  );
  const [scheduledArchivedShowingAll, setScheduledArchivedShowingAll] = useState(false);
  useEffect(() => {
    if (selectedArchivedScheduledThread) setScheduledArchivedExpanded(true);
  }, [routeThreadId, selectedArchivedScheduledThread]);
  const visibleScheduledThreads = scheduledExpanded
    ? currentScheduledThreads.filter(
        (thread, index) =>
          scheduledShowingAll || index < threadPreviewLimit || thread.id === routeThreadId,
      )
    : [];
  const visibleArchivedScheduledThreads =
    scheduledExpanded && scheduledArchivedExpanded
      ? archivedScheduledThreads.filter(
          (thread, index) =>
            scheduledArchivedShowingAll ||
            index < threadPreviewLimit ||
            thread.id === routeThreadId,
        )
      : [];
  const settledThreads = sidebarLists.settledThreads;
  const archivedSidebarItems = reconcileFrozenOrder({
    items: sidebarLists.archivedSidebarItems,
    getKey: (item) => item.key,
    frozenOrder: freezeSnapshot?.archivedItemKeysByProjectId[project.id],
  });
  const projectDraftThreadId = sidebarLists.projectDraftThreadId;

  // Aging: idle threads and finished workflows fold into one "N older" row.
  const agingEnabled = olderThreadDays > 0;
  const agingExemptKeys = new Set<string>(props.agingExemptThreadIds);
  for (const thread of activeThreads) {
    if (
      thread.pinnedAt != null ||
      thread.id === projectDraftThreadId ||
      isDraftThreadId(thread.id, draftThreadsByThreadId, persistedThreadIds)
    )
      agingExemptKeys.add(thread.id);
  }
  const workflowMeta = (entry: SidebarWorkflowEntry) =>
    sidebarLists.workflowMetaByKey.get(workflowEntryKey(entry));
  for (const entry of projectWorkflows) {
    const children = workflowThreadsByWorkflowId.get(entry.workflow.id) ?? [];
    const currentStep = workflowMeta(entry)?.currentStep ?? null;
    // A finished workflow whose PR is still open has work left: it stays in view, and so does
    // one whose PR state hasn't loaded yet. The last thread may be snoozed, so it is looked up
    // by id rather than among the visible children.
    const lastThreadIndicators =
      currentStep?.state === "completed" && currentStep.targetThreadId !== null
        ? indicatorsForThread({ id: currentStep.targetThreadId })
        : null;
    if (
      isWorkflowRouteActive(pathname, entry.workflow.id, entry.type) ||
      children.some((thread) => props.agingExemptThreadIds.has(thread.id)) ||
      lastThreadIndicators?.prStatus?.state === "open" ||
      lastThreadIndicators?.prPending === true
    )
      agingExemptKeys.add(workflowEntryKey(entry));
  }
  const agedThreads = partitionAgedSidebarItems(
    activeThreads,
    props.now,
    olderThreadDays,
    agingExemptKeys,
    {
      getKey: (thread) => thread.id,
      getActivityAt: (thread) => liveSidebarActivityAt(thread, props.liveActivityHours),
    },
  );
  const agedWorkflows = partitionAgedSidebarItems(
    projectWorkflows,
    props.now,
    olderThreadDays,
    agingExemptKeys,
    {
      getKey: workflowEntryKey,
      // Only finished workflows fold; a pending or running one stays in view.
      getActivityAt: (entry) =>
        workflowMeta(entry)?.overallState === "completed"
          ? workflowActivityAt({
              updatedAt: entry.workflow.updatedAt,
              threads: workflowThreadsByWorkflowId.get(entry.workflow.id) ?? [],
              finished: true,
              activityOf: (thread) => liveSidebarActivityAt(thread, props.liveActivityHours),
            })
          : null,
    },
  );
  const olderExpanded = isListExpanded("older");
  const olderCount = agedThreads.older.length + agedWorkflows.older.length;
  const visibleOlderWorkflows = olderExpanded ? agedWorkflows.older : [];
  const visibleOlderThreads = olderExpanded ? agedThreads.older : [];

  // The preview limit applies to the threads aging keeps in view: "Show more", then "N older".
  const activeExpanded = isListExpanded("active");
  const recentThreads = agingEnabled ? agedThreads.recent : activeThreads;
  const visibleActiveThreads = getVisibleThreadsWithPinnedDraft({
    threads: recentThreads,
    expanded: activeExpanded || recentThreads.length <= threadPreviewLimit,
    previewLimit: threadPreviewLimit,
    draftThreadId: projectDraftThreadId,
  });
  const visibleWorkflows = agingEnabled ? agedWorkflows.recent : projectWorkflows;
  const hasHiddenActiveThreads = recentThreads.length > threadPreviewLimit;
  const hiddenActiveCount = Math.max(0, recentThreads.length - visibleActiveThreads.length);

  // The shelf's open list, with the preview limit and "Show all N".
  const previewList = <T,>(
    items: readonly T[],
    bucket: SidebarThreadBucket,
    getId: (item: T) => string,
  ) =>
    isListExpanded(bucket) || items.length <= threadPreviewLimit
      ? [...items]
      : items.filter((item, index) => index < threadPreviewLimit || getId(item) === routeThreadId);
  const visibleSnoozedThreads =
    openShelfBucket === "snoozed"
      ? previewList(snoozedThreads, "snoozed", (thread) => thread.id)
      : [];
  const visibleSettledThreads =
    openShelfBucket === "settled"
      ? previewList(settledThreads, "settled", (thread) => thread.id)
      : [];
  const visibleArchivedItems =
    openShelfBucket === "archived"
      ? previewList(archivedSidebarItems, "archived", (item) =>
          item.kind === "thread" ? item.thread.id : item.key,
        )
      : [];
  const projectPinnedSortableIds = [
    ...visibleActiveThreads,
    ...visibleOlderThreads,
    ...visibleScheduledThreads,
  ]
    .filter((thread) => thread.pinnedAt != null)
    .map((thread) => pinnedThreadSortableId(thread.id));
  const orderedProjectThreadIds = [
    ...[...visibleActiveThreads, ...visibleOlderThreads]
      .filter((thread) => !isDraftThreadId(thread.id, draftThreadsByThreadId, persistedThreadIds))
      .map((thread) => thread.id),
    ...visibleScheduledThreads.map((thread) => thread.id),
    ...visibleArchivedScheduledThreads.map((thread) => thread.id),
    ...visibleSnoozedThreads.map((thread) => thread.id),
    ...visibleSettledThreads.map((thread) => thread.id),
    ...visibleArchivedItems.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : [])),
  ];
  const openScheduledMenu = useScheduledFolderMenu(scheduledThreads, indicatorsForThread);
  const shelfSegments: SidebarShelfSegment[] = [
    {
      bucket: "scheduled",
      count: scheduledThreads.length,
      indicator: (
        <ScheduledShelfIndicator
          summary={summarizeScheduledThreads(scheduledThreads, indicatorsForThread)}
        />
      ),
      onContextMenu: (position) => void openScheduledMenu(position),
    },
    { bucket: "snoozed", count: snoozedThreads.length },
    { bucket: "settled", count: settledThreads.length },
    { bucket: "archived", count: archivedSidebarItems.length },
  ];
  const renderWorkflow = (entry: SidebarWorkflowEntry) => {
    const meta = workflowMeta(entry);
    return (
      <SidebarWorkflowItem
        key={entry.workflow.id}
        entry={entry}
        workflowThreads={workflowThreadsByWorkflowId.get(entry.workflow.id) ?? []}
        threadLabels={meta?.threadLabels ?? new Map()}
        overallState={meta?.overallState ?? "pending"}
        phases={meta?.phases}
        currentStep={meta?.currentStep}
        pathname={pathname}
        routeThreadId={routeThreadId}
        expandByDefault={props.expandWorkflowThreadsByDefault}
        overrideExpanded={props.workflowExpandedById[entry.workflow.id]}
        expansionOverrides={props.workflowExpandedById}
        onToggleCollapsed={projectActions.onToggleWorkflowCollapsed}
        onArchive={projectActions.onArchiveWorkflow}
        indicatorsForThread={indicatorsForThread}
        actions={threadActions}
      />
    );
  };
  const renderActiveThread = (thread: (typeof activeThreads)[number]) => (
    <SidebarThreadRow
      key={thread.id}
      thread={thread}
      section="active"
      isActive={routeThreadId === thread.id}
      isDraft={isDraftThreadId(thread.id, draftThreadsByThreadId, persistedThreadIds)}
      orderedIds={orderedProjectThreadIds}
      isRenaming={threadActions.renamingThreadId === thread.id}
      actions={threadActions}
      {...indicatorsForThread(thread)}
    />
  );
  const activeCount = project.expanded
    ? 0
    : [
        ...activeThreads,
        ...currentScheduledThreads,
        ...[...sidebarLists.workflowThreadsByKey.values()].flat(),
      ].filter((thread) => {
        const label = indicatorsForThread(thread).threadStatus?.label;
        return label !== undefined && ACTIVE_STATUS_LABELS.has(label);
      }).length;

  return (
    <ProjectItemWrapper project={project}>
      {(dragHandleProps) => (
        <Collapsible className="group/collapsible" open={project.expanded}>
          <div className="group/project-header relative">
            <SidebarMenuButton
              className={cn(
                "h-8 gap-2 rounded-lg px-2 text-left text-ui font-medium text-foreground hover:bg-accent/60 hover:text-foreground group-hover/project-header:bg-accent/60",
                isScratchProject(project)
                  ? "group-has-[[data-sidebar=menu-action]]/menu-item:pe-14"
                  : "group-has-[[data-sidebar=menu-action]]/menu-item:pe-20",
              )}
              aria-expanded={project.expanded}
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
              // After the drag handle's attributes, which bring their own role and Tab stop.
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={sidebarProjectRowId(project.id)}
              onPointerDownCapture={projectActions.onTitlePointerDownCapture}
              onClick={(event) => projectActions.onTitleClick(event, project.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                projectActions.onContextMenu(project.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onKeyDown={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                ) {
                  projectActions.onTitleKeyDown(event, project.id);
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                projectActions.onContextMenu(project.id, {
                  x: rect.left,
                  y: rect.bottom,
                });
              }}
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                <ProjectIcon
                  projectId={project.id}
                  kind={project.kind}
                  name={project.name}
                  icon={project.icon}
                  className="size-4 shrink-0 text-muted-foreground transition-opacity duration-(--duration-fast) group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0"
                />
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    "absolute size-3.5 text-muted-foreground opacity-0 transition-[opacity,transform] duration-(--duration-fast) group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100",
                    project.expanded && "rotate-90",
                  )}
                />
              </span>
              {props.isRenamingProject ? (
                <InlineTitleEditor
                  initialValue={project.name}
                  ariaLabel="Rename project"
                  className="flex-1 text-ui font-medium text-foreground"
                  onCommit={(value) =>
                    projectActions.onCommitRename(project.id, value, project.name)
                  }
                  onCancel={projectActions.onCancelRename}
                />
              ) : (
                <span className="flex-1 truncate">{project.name}</span>
              )}
              {activeCount > 0 ? (
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-info/15 px-1 text-2xs font-medium text-info-foreground tabular-nums">
                  {activeCount}
                  <span className="sr-only"> active</span>
                </span>
              ) : null}
            </SidebarMenuButton>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuAction
                    render={
                      <button
                        type="button"
                        aria-label={`Project actions for ${project.name}`}
                        data-sidebar-action-for={sidebarProjectRowId(project.id)}
                      />
                    }
                    showOnHover
                    className={cn(
                      PROJECT_ACTION_CLASS_NAME,
                      isScratchProject(project) ? "right-8" : "right-[3.75rem]",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      projectActions.onContextMenu(project.id, { x: rect.left, y: rect.bottom });
                    }}
                  >
                    <EllipsisIcon className="size-4" />
                  </SidebarMenuAction>
                }
              />
              <TooltipPopup side="top">Project actions</TooltipPopup>
            </Tooltip>
            {/* Workflows review and implement in a repository, which a thread without a project lacks. */}
            {isScratchProject(project) ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuAction
                      render={
                        <button
                          type="button"
                          aria-label={`Create workflow in ${project.name}`}
                          data-sidebar-action-for={sidebarProjectRowId(project.id)}
                        />
                      }
                      showOnHover
                      className={cn(PROJECT_ACTION_CLASS_NAME, "right-8")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        projectActions.onCreateWorkflow(project.id);
                      }}
                    >
                      <WorkflowIcon className="size-4" />
                    </SidebarMenuAction>
                  }
                />
                <TooltipPopup side="top" className="flex items-center gap-2">
                  New workflow
                  {props.workflowShortcutLabel ? <Kbd>{props.workflowShortcutLabel}</Kbd> : null}
                </TooltipPopup>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuAction
                    render={
                      <button
                        type="button"
                        aria-label={`Create new thread in ${project.name}`}
                        data-sidebar-action-for={sidebarProjectRowId(project.id)}
                        data-testid="new-thread-button"
                      />
                    }
                    showOnHover
                    className={cn(PROJECT_ACTION_CLASS_NAME, "right-1")}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      threadActions.createThreadInProject(project.id, {
                        shiftKey: event.shiftKey,
                        metaKey: event.metaKey,
                        ctrlKey: event.ctrlKey,
                      });
                    }}
                  >
                    <SquarePenIcon className="size-4" />
                  </SidebarMenuAction>
                }
              />
              <TooltipPopup side="top" className="max-w-64 whitespace-normal">
                <span className="flex items-center gap-2">
                  New thread
                  {props.newThreadShortcutLabel ? <Kbd>{props.newThreadShortcutLabel}</Kbd> : null}
                </span>
                <span className="mt-1 block text-muted-foreground">
                  Shift-click uses the other workspace mode; Cmd/Ctrl+Shift-click opens a new
                  window.
                </span>
              </TooltipPopup>
            </Tooltip>
          </div>

          <CollapsibleContent keepMounted>
            <SidebarTreeParentContext.Provider value={sidebarProjectRowId(project.id)}>
              <DndContext
                sensors={props.dndSensors}
                collisionDetection={props.collisionDetection}
                modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                onDragEnd={projectActions.onPinnedThreadDragEnd}
              >
                <SortableContext
                  items={projectPinnedSortableIds}
                  strategy={verticalListSortingStrategy}
                >
                  {/* One tree level: the guide line sits under the project's folder icon. */}
                  <SidebarMenuSub className={SIDEBAR_TREE_LEVEL_CLASS_NAME}>
                    {visibleWorkflows.map(renderWorkflow)}
                    {visibleWorkflows.length > 0 && visibleActiveThreads.length > 0 ? (
                      <GroupGapRow />
                    ) : null}
                    {visibleActiveThreads.map(renderActiveThread)}

                    <MoreAndOlderRow
                      more={
                        hasHiddenActiveThreads
                          ? {
                              label: activeExpanded
                                ? "Show less"
                                : hiddenActiveCount > 0
                                  ? `Show ${hiddenActiveCount} more`
                                  : "Show more",
                              onToggle: () => toggleList("active"),
                            }
                          : undefined
                      }
                      older={
                        agingEnabled && olderCount > 0
                          ? {
                              label: `${olderCount} older than ${olderThreadDays} days`,
                              expanded: olderExpanded,
                              onToggle: () => toggleList("older"),
                            }
                          : undefined
                      }
                    />
                    {visibleOlderWorkflows.map(renderWorkflow)}
                    {visibleOlderThreads.map(renderActiveThread)}

                    <SidebarShelfRow
                      projectId={project.id}
                      segments={shelfSegments}
                      openBucket={openShelfBucket}
                      onToggle={(bucket) => projectActions.onToggleShelfBucket(project.id, bucket)}
                    >
                      {openShelfBucket === "scheduled" ? (
                        <SidebarScheduledShelfList
                          visibleThreads={visibleScheduledThreads}
                          currentThreadCount={currentScheduledThreads.length}
                          archivedThreads={archivedScheduledThreads}
                          visibleArchivedThreads={visibleArchivedScheduledThreads}
                          archivedExpanded={scheduledArchivedExpanded}
                          archivedShowingAll={scheduledArchivedShowingAll}
                          showingAll={scheduledShowingAll}
                          previewLimit={threadPreviewLimit}
                          onToggleShowAll={() => setScheduledShowingAll((showing) => !showing)}
                          onToggleArchived={() =>
                            setScheduledArchivedExpanded((expanded) => !expanded)
                          }
                          onToggleArchivedShowAll={() =>
                            setScheduledArchivedShowingAll((showing) => !showing)
                          }
                          routeThreadId={routeThreadId}
                          orderedIds={orderedProjectThreadIds}
                          indicatorsForThread={indicatorsForThread}
                          actions={threadActions}
                        />
                      ) : null}
                      {visibleSnoozedThreads.map((thread) => (
                        <SidebarThreadRow
                          key={`snoozed:${thread.id}`}
                          thread={thread}
                          section="snoozed"
                          isActive={routeThreadId === thread.id}
                          orderedIds={orderedProjectThreadIds}
                          threadStatus={null}
                          prStatus={null}
                          isUnread={indicatorsForThread(thread).isUnread}
                          isRenaming={false}
                          actions={threadActions}
                        />
                      ))}
                      {visibleSettledThreads.map((thread) => (
                        <SidebarThreadRow
                          key={`settled:${thread.id}`}
                          thread={thread}
                          section="settled"
                          isActive={routeThreadId === thread.id}
                          orderedIds={orderedProjectThreadIds}
                          isRenaming={threadActions.renamingThreadId === thread.id}
                          actions={threadActions}
                          {...indicatorsForThread(thread)}
                          threadStatus={null}
                        />
                      ))}
                      {visibleArchivedItems.map((item) =>
                        item.kind === "workflow" ? (
                          <SidebarArchivedWorkflowRow
                            key={item.key}
                            type={item.type}
                            workflow={item.workflow}
                            pathname={pathname}
                            onUnarchive={projectActions.onUnarchiveWorkflow}
                          />
                        ) : (
                          <SidebarThreadRow
                            key={item.key}
                            thread={item.thread}
                            section="archived"
                            isActive={routeThreadId === item.thread.id}
                            orderedIds={orderedProjectThreadIds}
                            isRenaming={threadActions.renamingThreadId === item.thread.id}
                            actions={threadActions}
                            {...indicatorsForThread(item.thread)}
                          />
                        ),
                      )}
                      {(
                        [
                          ["snoozed", snoozedThreads.length],
                          ["settled", settledThreads.length],
                          ["archived", archivedSidebarItems.length],
                        ] as const
                      ).map(([bucket, count]) =>
                        openShelfBucket === bucket && count > threadPreviewLimit ? (
                          <ListToggleRow
                            key={`show-all:${bucket}`}
                            label={isListExpanded(bucket) ? "Show less" : `Show all ${count}`}
                            onSelect={() => toggleList(bucket)}
                          />
                        ) : null,
                      )}
                    </SidebarShelfRow>
                  </SidebarMenuSub>
                </SortableContext>
              </DndContext>
            </SidebarTreeParentContext.Provider>
          </CollapsibleContent>
        </Collapsible>
      )}
    </ProjectItemWrapper>
  );
}
