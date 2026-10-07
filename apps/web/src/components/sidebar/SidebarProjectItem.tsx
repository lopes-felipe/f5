import type { ProjectId, ThreadId } from "@t3tools/contracts";
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
import type { ReactNode } from "react";

import type { DraftThreadState } from "../../composerDraftStore";
import { getVisibleThreadsWithPinnedDraft, isDraftThreadId } from "../../lib/draftThreads";
import { cn } from "../../lib/utils";
import type { Project, Thread } from "../../types";
import { InlineTitleEditor } from "../InlineTitleEditor";
import { ProjectIcon } from "../ProjectIcon";
import {
  reconcileFrozenOrder,
  SIDEBAR_TREE_LEVEL_CLASS_NAME,
  type SidebarThreadBucket,
} from "../Sidebar.logic";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Kbd } from "../ui/kbd";
import {
  type ProjectSidebarLists,
  type SidebarHoverFreezeSnapshot,
  type SidebarWorkflowId,
  type SidebarWorkflowType,
  pinnedThreadSortableId,
  workflowEntryKey,
} from "./sidebarLists";
import { SidebarThreadRow } from "./SidebarThreadRow";
import {
  SidebarArchivedWorkflowRow,
  SidebarWorkflowItem,
  type SidebarThreadRowIndicators,
} from "./SidebarWorkflowItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";

type SortableProjectHandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

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
  onToggleArchivedSection: (projectId: ProjectId) => void;
  onToggleSnoozedSection: (projectId: ProjectId) => void;
  onPinnedThreadDragEnd: (event: DragEndEvent) => void;
}

export interface SidebarProjectItemProps {
  project: Project;
  sidebarLists: ProjectSidebarLists;
  freezeSnapshot: SidebarHoverFreezeSnapshot | null;
  threadPreviewLimit: number;
  activeExpanded: boolean;
  archivedExpanded: boolean;
  archivedSectionCollapsed: boolean;
  snoozedSectionCollapsed: boolean;
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
  indicatorsForThread: (thread: Thread) => SidebarThreadRowIndicators;
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

/** "Show more" / "Show less" under a list. */
function ListToggleRow(props: { label: string; onSelect: () => void }) {
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<button type="button" />}
        data-thread-selection-safe
        size="sm"
        className="h-6 w-full translate-x-0 justify-start rounded-md pl-8 text-left text-2xs text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={props.onSelect}
      >
        <span>{props.label}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/**
 * Static group heading ("Workflows" / "Threads") that separates workflow
 * entries from standalone threads inside a project. Matches the type scale of
 * {@link SectionToggleRow}; the optional top border divides the two groups.
 */
function GroupLabelRow(props: { label: string; divided?: boolean }) {
  return (
    <SidebarMenuSubItem className="w-full">
      <div
        className={cn(
          "flex min-h-6 items-center px-2 text-2xs font-medium text-faint-foreground select-none",
          props.divided && "mt-1.5 border-t border-border/60 pt-1",
        )}
      >
        {props.label}
      </div>
    </SidebarMenuSubItem>
  );
}

/** Collapsible "Snoozed (n)" / "Archived" section label. */
function SectionToggleRow(props: { label: ReactNode; expanded: boolean; onToggle: () => void }) {
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<button type="button" />}
        data-thread-selection-safe
        aria-expanded={props.expanded}
        size="sm"
        className="mt-1 h-6 w-full translate-x-0 justify-start gap-1 rounded-md px-2 text-left text-2xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={props.onToggle}
      >
        <span>{props.label}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
            props.expanded && "rotate-90",
          )}
        />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

export function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    sidebarLists,
    freezeSnapshot,
    threadPreviewLimit,
    activeExpanded,
    archivedExpanded,
    archivedSectionCollapsed,
    snoozedSectionCollapsed,
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
  const projectPinnedSortableIds = activeThreads
    .filter((thread) => thread.pinnedAt != null)
    .map((thread) => pinnedThreadSortableId(thread.id));
  const archivedSidebarItems = reconcileFrozenOrder({
    items: sidebarLists.archivedSidebarItems,
    getKey: (item) => item.key,
    frozenOrder: freezeSnapshot?.archivedItemKeysByProjectId[project.id],
  });
  const projectDraftThreadId = sidebarLists.projectDraftThreadId;
  const visibleActiveThreads = getVisibleThreadsWithPinnedDraft({
    threads: activeThreads,
    expanded: activeExpanded || activeThreads.length <= threadPreviewLimit,
    previewLimit: threadPreviewLimit,
    draftThreadId: projectDraftThreadId,
  });
  const visibleArchivedItems =
    archivedExpanded || archivedSidebarItems.length <= threadPreviewLimit
      ? archivedSidebarItems
      : archivedSidebarItems.slice(0, threadPreviewLimit);
  const hasHiddenActiveThreads = activeThreads.length > threadPreviewLimit;
  // Only label the groups when both are present; a lone list needs no heading.
  const showGroupLabels = projectWorkflows.length > 0 && visibleActiveThreads.length > 0;
  const hasHiddenArchivedItems = archivedSidebarItems.length > threadPreviewLimit;
  const orderedProjectThreadIds = [
    ...visibleActiveThreads
      .filter((thread) => !isDraftThreadId(thread.id, draftThreadsByThreadId, persistedThreadIds))
      .map((thread) => thread.id),
    ...(!snoozedSectionCollapsed ? snoozedThreads.map((thread) => thread.id) : []),
    ...(!archivedSectionCollapsed
      ? visibleArchivedItems.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : []))
      : []),
  ];
  const activeCount = project.expanded
    ? 0
    : [...activeThreads, ...[...sidebarLists.workflowThreadsByKey.values()].flat()].filter(
        (thread) => {
          const label = indicatorsForThread(thread).threadStatus?.label;
          return label !== undefined && ACTIVE_STATUS_LABELS.has(label);
        },
      ).length;

  return (
    <SortableProjectItem projectId={project.id}>
      {(dragHandleProps) => (
        <Collapsible className="group/collapsible" open={project.expanded}>
          <div className="group/project-header relative">
            <SidebarMenuButton
              className="h-8 gap-2 rounded-lg px-2 text-left text-ui font-medium text-foreground hover:bg-accent/60 hover:text-foreground group-hover/project-header:bg-accent/60 group-has-[[data-sidebar=menu-action]]/menu-item:pe-20"
              aria-expanded={project.expanded}
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
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
                      <button type="button" aria-label={`Project actions for ${project.name}`} />
                    }
                    showOnHover
                    className={cn(PROJECT_ACTION_CLASS_NAME, "right-[3.75rem]")}
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuAction
                    render={
                      <button type="button" aria-label={`Create workflow in ${project.name}`} />
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuAction
                    render={
                      <button
                        type="button"
                        aria-label={`Create new thread in ${project.name}`}
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
                  {showGroupLabels ? <GroupLabelRow label="Workflows" /> : null}
                  {projectWorkflows.map((entry) => {
                    const meta = sidebarLists.workflowMetaByKey.get(workflowEntryKey(entry));
                    return (
                      <SidebarWorkflowItem
                        key={entry.workflow.id}
                        entry={entry}
                        workflowThreads={workflowThreadsByWorkflowId.get(entry.workflow.id) ?? []}
                        threadLabels={meta?.threadLabels ?? new Map()}
                        overallState={meta?.overallState ?? "pending"}
                        pathname={pathname}
                        routeThreadId={routeThreadId}
                        expandByDefault={props.expandWorkflowThreadsByDefault}
                        overrideExpanded={props.workflowExpandedById[entry.workflow.id]}
                        onToggleCollapsed={projectActions.onToggleWorkflowCollapsed}
                        onArchive={projectActions.onArchiveWorkflow}
                        indicatorsForThread={indicatorsForThread}
                        actions={threadActions}
                      />
                    );
                  })}
                  {showGroupLabels ? <GroupLabelRow label="Threads" divided /> : null}
                  {visibleActiveThreads.map((thread) => {
                    const isDraftThread = isDraftThreadId(
                      thread.id,
                      draftThreadsByThreadId,
                      persistedThreadIds,
                    );
                    return (
                      <SidebarThreadRow
                        key={thread.id}
                        thread={thread}
                        section="active"
                        isActive={routeThreadId === thread.id}
                        isDraft={isDraftThread}
                        orderedIds={orderedProjectThreadIds}
                        isRenaming={threadActions.renamingThreadId === thread.id}
                        actions={threadActions}
                        {...indicatorsForThread(thread)}
                      />
                    );
                  })}

                  {hasHiddenActiveThreads ? (
                    <ListToggleRow
                      label={activeExpanded ? "Show less" : "Show more"}
                      onSelect={() => {
                        if (activeExpanded) {
                          projectActions.onCollapseThreadList(project.id, "active");
                        } else {
                          projectActions.onExpandThreadList(project.id, "active");
                        }
                      }}
                    />
                  ) : null}

                  {snoozedThreads.length > 0 ? (
                    <SectionToggleRow
                      label={`Snoozed (${snoozedThreads.length})`}
                      expanded={!snoozedSectionCollapsed}
                      onToggle={() => projectActions.onToggleSnoozedSection(project.id)}
                    />
                  ) : null}

                  {!snoozedSectionCollapsed
                    ? snoozedThreads.map((thread) => (
                        <SidebarThreadRow
                          key={`snoozed:${thread.id}`}
                          thread={thread}
                          section="snoozed"
                          isActive={routeThreadId === thread.id}
                          orderedIds={orderedProjectThreadIds}
                          threadStatus={null}
                          prStatus={null}
                          terminalStatus={null}
                          isRenaming={false}
                          actions={threadActions}
                        />
                      ))
                    : null}

                  {archivedSidebarItems.length > 0 ? (
                    <SectionToggleRow
                      label="Archived"
                      expanded={!archivedSectionCollapsed}
                      onToggle={() => projectActions.onToggleArchivedSection(project.id)}
                    />
                  ) : null}

                  {!archivedSectionCollapsed &&
                    visibleArchivedItems.map((item) =>
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

                  {!archivedSectionCollapsed && hasHiddenArchivedItems ? (
                    <ListToggleRow
                      label={archivedExpanded ? "Show less" : "Show more"}
                      onSelect={() => {
                        if (archivedExpanded) {
                          projectActions.onCollapseThreadList(project.id, "archived");
                        } else {
                          projectActions.onExpandThreadList(project.id, "archived");
                        }
                      }}
                    />
                  ) : null}
                </SidebarMenuSub>
              </SortableContext>
            </DndContext>
          </CollapsibleContent>
        </Collapsible>
      )}
    </SortableProjectItem>
  );
}
