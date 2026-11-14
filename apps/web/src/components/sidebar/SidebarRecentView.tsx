import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { Schema } from "effect";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { DraftThreadState } from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isDraftThreadId } from "../../lib/draftThreads";
import { attachSidebarTree, SIDEBAR_TREE_PROPS } from "../../lib/sidebarTree";
import { cn } from "../../lib/utils";
import type { ThreadSummary } from "../../threadSelectors";
import type { ThreadStatus } from "../../threadStatus";
import type { Project } from "../../types";
import { ProjectIcon } from "../ProjectIcon";
import { reconcileFrozenOrder } from "../Sidebar.logic";
import { SidebarMenu, SidebarMenuItem, SidebarMenuSub } from "../ui/sidebar";
import { type ProjectSidebarLists, workflowEntryKey } from "./sidebarLists";
import {
  bucketRecentSidebarItems,
  collectRecentSidebarItems,
  RECENT_SIDEBAR_BUCKET_LABELS,
  RECENT_SIDEBAR_BUCKETS,
  type RecentSidebarBucket,
  type RecentSidebarItem,
} from "./sidebarRecent";
import { ListToggleRow } from "./SidebarSectionRows";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { SidebarTreeParentContext } from "./sidebarTreeRow";
import { SidebarWorkflowItem, type SidebarIndicatorsForThread } from "./SidebarWorkflowItem";
import type { SidebarProjectActions } from "./SidebarProjectItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";

export const SIDEBAR_RECENT_PROJECT_STORAGE_KEY = "f5:sidebar:recent-project";
const RecentProjectFilterSchema = Schema.NullOr(Schema.String);

function recentBucketRowId(bucket: RecentSidebarBucket): string {
  return `recent:${bucket}`;
}

/**
 * Project tag on a Recent row: icon and name, like "Needs you" rows. In a narrow sidebar
 * only the icon shows, so the thread title keeps the room.
 */
function RecentProjectTag({ project }: { project: Project | undefined }) {
  if (!project) return null;
  const name = isScratchProject(project) ? "No project" : project.name;
  return (
    <span
      title={name}
      className="flex min-w-0 max-w-14 shrink items-center gap-1 text-2xs font-normal text-muted-foreground"
      data-testid="recent-project-tag"
    >
      <ProjectIcon
        projectId={project.id}
        kind={project.kind}
        name={name}
        icon={project.icon}
        className="size-3 shrink-0"
      />
      <span className="hidden truncate @[14rem]/recent:inline">{name}</span>
    </span>
  );
}

/**
 * Every project's live threads and workflows by recency: Pinned, Running, Today, Yesterday,
 * This week and Earlier (collapsed), filtered by a remembered project chip.
 */
export function SidebarRecentView(props: {
  projects: readonly Project[];
  listsByProjectId: ReadonlyMap<ProjectId, ProjectSidebarLists<ThreadSummary>>;
  statusById: ReadonlyMap<ThreadId, ThreadStatus>;
  now: number;
  /** Live activity hours by thread id (`useLiveActivityHours`); summary times can lag. */
  liveActivityHours: Readonly<Record<string, number>>;
  /** Item keys in their order when the pointer entered the sidebar. */
  frozenItemKeys: readonly string[] | undefined;
  threadPreviewLimit: number;
  draftThreadsByThreadId: Readonly<Record<ThreadId, DraftThreadState>>;
  persistedThreadIds: ReadonlySet<ThreadId>;
  routeThreadId: ThreadId | null;
  pathname: string;
  expandWorkflowThreadsByDefault: boolean;
  workflowExpandedById: Readonly<Record<string, boolean>>;
  indicatorsForThread: SidebarIndicatorsForThread;
  threadActions: SidebarThreadActions;
  projectActions: Pick<SidebarProjectActions, "onToggleWorkflowCollapsed" | "onArchiveWorkflow">;
}) {
  "use memo";
  const { projects, listsByProjectId, routeThreadId } = props;
  const [storedProjectFilter, setProjectFilter] = useLocalStorage(
    SIDEBAR_RECENT_PROJECT_STORAGE_KEY,
    null,
    RecentProjectFilterSchema,
  );
  const [collapsedBuckets, setCollapsedBuckets] = useState<ReadonlySet<RecentSidebarBucket>>(
    () => new Set(["earlier"]),
  );
  const [earlierShowingAll, setEarlierShowingAll] = useState(false);

  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const allItems = collectRecentSidebarItems(listsByProjectId, props.liveActivityHours);
  const listedProjects = projects.filter((project) => !isScratchProject(project));
  const scratchProjects = projects.filter(
    (project) =>
      isScratchProject(project) && allItems.some((item) => item.projectId === project.id),
  );
  const chipProjects = [...listedProjects, ...scratchProjects];
  // A remembered project that no longer exists falls back to All.
  const projectFilter = chipProjects.some((project) => project.id === storedProjectFilter)
    ? (storedProjectFilter as ProjectId)
    : null;
  const items =
    projectFilter === null ? allItems : allItems.filter((item) => item.projectId === projectFilter);
  const liveBuckets = bucketRecentSidebarItems(items, props.statusById, props.now);
  const buckets = RECENT_SIDEBAR_BUCKETS.map((bucket) => ({
    bucket,
    items: reconcileFrozenOrder({
      items: liveBuckets[bucket],
      getKey: (item) => item.key,
      frozenOrder: props.frozenItemKeys,
    }),
  }));
  // The bucket holding the open thread (directly, or as a workflow's child) opens for it.
  const holdsRouteThread = (item: RecentSidebarItem) =>
    routeThreadId !== null &&
    (item.kind === "thread"
      ? item.thread.id === routeThreadId
      : (listsByProjectId.get(item.projectId)?.workflowThreadsByKey.get(item.key) ?? []).some(
          (thread) => thread.id === routeThreadId,
        ));
  const routeBucket =
    RECENT_SIDEBAR_BUCKETS.find((bucket) => liveBuckets[bucket].some(holdsRouteThread)) ?? null;
  useEffect(() => {
    if (routeBucket === null) return;
    setCollapsedBuckets((current) => {
      if (!current.has(routeBucket)) return current;
      const next = new Set(current);
      next.delete(routeBucket);
      return next;
    });
  }, [routeThreadId, routeBucket]);
  const isDraft = (threadId: ThreadId) =>
    isDraftThreadId(threadId, props.draftThreadsByThreadId, props.persistedThreadIds);
  const visibleItemsOf = (bucket: RecentSidebarBucket, bucketItems: RecentSidebarItem[]) => {
    if (collapsedBuckets.has(bucket)) return [];
    if (bucket !== "earlier" || earlierShowingAll) return bucketItems;
    return bucketItems.filter(
      (item, index) =>
        index < props.threadPreviewLimit ||
        (item.kind === "thread" && item.thread.id === routeThreadId),
    );
  };
  const orderedThreadIds = buckets.flatMap(({ bucket, items: bucketItems }) =>
    visibleItemsOf(bucket, bucketItems).flatMap((item) =>
      item.kind === "thread" && !isDraft(item.thread.id) ? [item.thread.id] : [],
    ),
  );
  const toggleBucket = (bucket: RecentSidebarBucket) =>
    setCollapsedBuckets((current) => {
      const next = new Set(current);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });

  const renderItem = (item: RecentSidebarItem) => {
    if (item.kind === "workflow") {
      const lists = listsByProjectId.get(item.projectId);
      const key = workflowEntryKey(item.entry);
      const meta = lists?.workflowMetaByKey.get(key);
      return (
        <SidebarWorkflowItem
          key={item.key}
          entry={item.entry}
          workflowThreads={lists?.workflowThreadsByKey.get(key) ?? []}
          threadLabels={meta?.threadLabels ?? new Map()}
          overallState={meta?.overallState ?? "pending"}
          phases={meta?.phases}
          currentStep={meta?.currentStep}
          pathname={props.pathname}
          routeThreadId={routeThreadId}
          expandByDefault={props.expandWorkflowThreadsByDefault}
          overrideExpanded={props.workflowExpandedById[item.entry.workflow.id]}
          expansionOverrides={props.workflowExpandedById}
          onToggleCollapsed={props.projectActions.onToggleWorkflowCollapsed}
          onArchive={props.projectActions.onArchiveWorkflow}
          indicatorsForThread={props.indicatorsForThread}
          actions={props.threadActions}
        />
      );
    }
    const { thread } = item;
    return (
      <SidebarThreadRow
        key={item.key}
        thread={thread}
        section="recent"
        isActive={routeThreadId === thread.id}
        isDraft={isDraft(thread.id)}
        orderedIds={orderedThreadIds}
        trailingMeta={
          projectFilter === null ? (
            <RecentProjectTag project={projectById.get(item.projectId)} />
          ) : undefined
        }
        isRenaming={props.threadActions.renamingThreadId === thread.id}
        actions={props.threadActions}
        {...props.indicatorsForThread(thread)}
      />
    );
  };

  return (
    <div className="@container/recent" data-testid="sidebar-recent-view">
      <div
        role="group"
        aria-label="Filter recent threads by project"
        className="flex gap-1 overflow-x-auto px-1 pb-1.5 [scrollbar-width:none]"
      >
        {[
          { id: null, label: "All" },
          ...chipProjects.map((project) => ({
            id: project.id,
            label: isScratchProject(project) ? "No project" : project.name,
          })),
        ].map((chip) => (
          <button
            key={chip.id ?? "all"}
            type="button"
            aria-pressed={projectFilter === chip.id}
            data-testid={`recent-project-chip-${chip.id ?? "all"}`}
            className="shrink-0 rounded-full border border-border px-2 py-0.5 text-2xs whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-transparent aria-pressed:bg-accent aria-pressed:text-foreground"
            onClick={() => setProjectFilter(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-4 text-center text-2xs text-muted-foreground">
          Nothing recent here yet.
        </p>
      ) : (
        <SidebarMenu
          {...SIDEBAR_TREE_PROPS}
          aria-label="Recent threads"
          ref={attachSidebarTree}
          className="gap-px"
        >
          {buckets.map(({ bucket, items: bucketItems }) => {
            if (bucketItems.length === 0) return null;
            const expanded = !collapsedBuckets.has(bucket);
            const visibleItems = visibleItemsOf(bucket, bucketItems);
            return (
              <SidebarMenuItem key={bucket} data-recent-bucket={bucket}>
                <button
                  type="button"
                  role="treeitem"
                  tabIndex={-1}
                  data-sidebar-row={recentBucketRowId(bucket)}
                  aria-expanded={expanded}
                  data-thread-selection-safe
                  className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => toggleBucket(bucket)}
                >
                  {RECENT_SIDEBAR_BUCKET_LABELS[bucket]}
                  <span className="tabular-nums text-faint-foreground">{bucketItems.length}</span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 text-faint-foreground transition-transform duration-(--duration-fast)",
                      expanded && "rotate-90",
                    )}
                  />
                </button>
                {expanded ? (
                  <SidebarTreeParentContext.Provider value={recentBucketRowId(bucket)}>
                    <SidebarMenuSub className="mx-0 w-full translate-x-0 gap-px border-l-0 px-0 py-0">
                      {visibleItems.map(renderItem)}
                      {bucket === "earlier" && bucketItems.length > props.threadPreviewLimit ? (
                        <ListToggleRow
                          label={earlierShowingAll ? "Show less" : "Show more"}
                          onSelect={() => setEarlierShowingAll((showing) => !showing)}
                        />
                      ) : null}
                    </SidebarMenuSub>
                  </SidebarTreeParentContext.Provider>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}
    </div>
  );
}
