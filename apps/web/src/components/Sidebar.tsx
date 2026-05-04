import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  FolderIcon,
  GitPullRequestIcon,
  HomeIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type CodeReviewWorkflow,
  type DesktopUpdateState,
  type PlanningWorkflow,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflowId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isArchivedWorkflow, partitionWorkflowsByArchive } from "@t3tools/shared/workflowArchive";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { formatRelativeTimeLabel } from "../lib/relativeTime";
import { isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import {
  getMostRecentProject,
  getMostRecentThreadForProject,
  isArchivedThread,
  partitionThreadsByArchive,
  sortThreadsByActivity,
} from "../lib/threadOrdering";
import {
  getProjectActiveThreadsWithPinnedDraft,
  getProjectThreadsWithDraft,
  getVisibleThreadsWithPinnedDraft,
  isDraftThreadId,
} from "../lib/draftThreads";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useStore } from "../store";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useWorkflowCreateDialogStore } from "../workflowCreateDialogStore";
import { useCreateProjectBackedDraftThread } from "../hooks/useCreateProjectBackedDraftThread";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { toastManager } from "./ui/toast";
import { type Project, type Thread } from "../types";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldHighlightDesktopUpdateError,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  reconcileFrozenOrder,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  resolveWorkflowThreadListExpanded,
  shouldClearThreadSelectionOnMouseDown,
  toggleWorkflowThreadListExpansion,
  threadBucketExpansionKey,
  type SidebarThreadBucket,
} from "./Sidebar.logic";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { isWsInteractionBlocked, useWsConnectionState } from "../wsConnectionState";
import { ThreadStatusPillBadge } from "./thread/ThreadStatusPillBadge";
import { WorkflowCreateDialog } from "./workflow/WorkflowCreateDialog";
import { threadIdsForCodeReviewWorkflow } from "./workflow/codeReviewWorkflowUtils";
import { threadIdsForWorkflow, workflowThreadDisplayTitle } from "./workflow/workflowUtils";
import { resolveSettingsNavigationSearch } from "./settings/settingsCategories";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

type SidebarWorkflowEntry =
  | {
      type: "planning";
      workflow: PlanningWorkflow;
    }
  | {
      type: "codeReview";
      workflow: CodeReviewWorkflow;
    };

type ArchivedSidebarItem =
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
      type: SidebarWorkflowEntry["type"];
      workflow: PlanningWorkflow | CodeReviewWorkflow;
    };

type SidebarProjectDraftThread = DraftThreadState & {
  threadId: ThreadId;
};

interface ProjectSidebarLists {
  projectWorkflows: SidebarWorkflowEntry[];
  workflowThreadsByKey: Map<string, Thread[]>;
  activeThreads: Thread[];
  archivedSidebarItems: ArchivedSidebarItem[];
  projectDraftThreadId: ThreadId | null;
}

interface SidebarHoverFreezeSnapshot {
  workflowKeysByProjectId: Readonly<Record<string, readonly string[]>>;
  workflowThreadIdsByWorkflowKey: Readonly<Record<string, readonly ThreadId[]>>;
  activeThreadIdsByProjectId: Readonly<Record<string, readonly ThreadId[]>>;
  archivedItemKeysByProjectId: Readonly<Record<string, readonly string[]>>;
}

function workflowEntryKey(entry: SidebarWorkflowEntry): string {
  return `${entry.type}:${entry.workflow.id}`;
}

function buildProjectSidebarLists(input: {
  project: Project;
  threads: ReadonlyArray<Thread>;
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  draftThread: SidebarProjectDraftThread | null;
}): ProjectSidebarLists {
  const { project, threads, planningWorkflows, codeReviewWorkflows, draftThread } = input;
  const allProjectPlanningWorkflows = planningWorkflows.filter(
    (workflow) => workflow.projectId === project.id,
  );
  const allProjectCodeReviewWorkflows = codeReviewWorkflows.filter(
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
  const projectWorkflows = sortWorkflowEntriesByActivity([
    ...activeProjectPlanningWorkflows.map((workflow) => ({
      workflow,
      type: "planning" as const,
    })),
    ...activeProjectCodeReviewWorkflows.map((workflow) => ({
      workflow,
      type: "codeReview" as const,
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
  ]);

  const workflowThreadIds = new Set(
    allProjectPlanningWorkflows.flatMap((workflow) => threadIdsForWorkflow(workflow)),
  );
  for (const workflow of allProjectCodeReviewWorkflows) {
    for (const threadId of threadIdsForCodeReviewWorkflow(workflow)) {
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
          return entry.type === "planning"
            ? threadIdsForWorkflow(entry.workflow).includes(thread.id)
            : threadIdsForCodeReviewWorkflow(entry.workflow).includes(thread.id);
        }),
      ),
    ]),
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

  return {
    projectWorkflows,
    workflowThreadsByKey,
    activeThreads,
    archivedSidebarItems,
    projectDraftThreadId,
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

function isWorkflowRouteActive(
  pathname: string,
  workflowId: PlanningWorkflowId | CodeReviewWorkflowId,
  type: SidebarWorkflowEntry["type"],
): boolean {
  return type === "planning"
    ? pathname === `/workflow/${workflowId}` || pathname === `/_chat/workflow/${workflowId}`
    : pathname === `/code-review/${workflowId}` || pathname === `/_chat/code-review/${workflowId}`;
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function resolveThreadRecencyTextClassName(input: {
  isHighlighted: boolean;
  hideOnHover: boolean;
  archived?: boolean | undefined;
}): string {
  const toneClass = input.archived
    ? input.isHighlighted
      ? "text-foreground/65"
      : "text-muted-foreground/40"
    : input.isHighlighted
      ? "text-foreground/72 dark:text-foreground/82"
      : "text-muted-foreground/40";

  return [
    "block text-[10px]",
    input.hideOnHover ? "group-hover/thread-row:hidden group-focus-within/thread-row:hidden" : "",
    toneClass,
  ]
    .filter(Boolean)
    .join(" ");
}

function ThreadRowTrailingMeta(props: {
  lastInteractionAt: string;
  terminalStatus: TerminalStatusIndicator | null;
  isHighlighted: boolean;
  archived?: boolean | undefined;
  action?:
    | {
        label: string;
        ariaLabel: string;
        onClick: () => void;
      }
    | undefined;
}) {
  const action = props.action ?? null;
  const actionClassName = props.isHighlighted ? "text-foreground/70" : "text-muted-foreground/70";

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {props.terminalStatus ? (
        <span
          role="img"
          aria-label={props.terminalStatus.label}
          title={props.terminalStatus.label}
          className={`inline-flex items-center justify-center ${props.terminalStatus.colorClass}`}
        >
          <TerminalIcon className={`size-3 ${props.terminalStatus.pulse ? "animate-pulse" : ""}`} />
        </span>
      ) : null}
      <div className="shrink-0 text-right">
        <span
          className={resolveThreadRecencyTextClassName({
            isHighlighted: props.isHighlighted,
            hideOnHover: action !== null,
            archived: props.archived,
          })}
        >
          {formatRelativeTimeLabel(props.lastInteractionAt)}
        </span>
        {action ? (
          <button
            type="button"
            aria-label={action.ariaLabel}
            className={`hidden whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/thread-row:inline-flex group-focus-within/thread-row:inline-flex ${actionClassName}`}
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              action.onClick();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function F5Wordmark() {
  return (
    <svg
      aria-label="F5"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="0 0 84 44"
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="1"
        y="33"
        fill="currentColor"
        fontFamily="'Arial Black', 'SF Pro Display', sans-serif"
        fontSize="34"
        fontWeight="900"
        letterSpacing="-2"
      >
        F5
      </text>
    </svg>
  );
}

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  // Parse to extract just the origin, dropping path/query (e.g. ?token=…)
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

function ProjectFavicon({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }

  return (
    <img
      src={src}
      alt=""
      className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loading" ? "hidden" : ""}`}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}

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
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners })}
    </li>
  );
}

type InlineTitleEditorProps = {
  initialValue: string;
  onCommit: (nextValue: string) => void;
  onCancel: () => void;
  className?: string;
  ariaLabel?: string;
};

/**
 * Shared inline-rename text input: focus + select on mount, Enter commits,
 * Escape cancels, blur commits unless Enter/Escape already fired. Owns its own
 * draft state so callers only see the final value when the user commits.
 */
function InlineTitleEditor({
  initialValue,
  onCommit,
  onCancel,
  className,
  ariaLabel,
}: InlineTitleEditorProps) {
  const [value, setValue] = useState(initialValue);
  const committedRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const handleRef = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={handleRef}
      aria-label={ariaLabel}
      className={
        className ??
        "min-w-0 flex-1 truncate border border-ring rounded bg-transparent px-0.5 text-base outline-none sm:text-xs"
      }
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          if (committedRef.current) return;
          committedRef.current = true;
          onCommitRef.current(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (committedRef.current) return;
          committedRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (committedRef.current) return;
        committedRef.current = true;
        // Treat a blur with an empty/whitespace input as cancel so users can
        // bail out of a rename by clearing the field + clicking elsewhere,
        // rather than triggering a rename-to-empty warning or round-trip.
        if (value.trim().length === 0) {
          onCancel();
          return;
        }
        onCommitRef.current(value);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function SidebarThreadTitle({ thread }: { thread: Thread }) {
  const suppressTooltip = useMediaQuery("(hover: none), (pointer: coarse)");
  const title = (
    <span className="min-w-0 flex-1 truncate text-xs" data-testid={`thread-title-${thread.id}`}>
      {thread.title}
    </span>
  );

  if (suppressTooltip) {
    return title;
  }

  return (
    <Tooltip>
      <TooltipTrigger delay={250} render={title} />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        {thread.title}
      </TooltipPopup>
    </Tooltip>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const planningWorkflows = useStore((store) => store.planningWorkflows);
  const codeReviewWorkflows = useStore((store) => store.codeReviewWorkflows);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const navigate = useNavigate();
  const settingsLocation = useLocation({
    select: (location) => ({
      pathname: location.pathname,
      search: location.search,
    }),
  });
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const isOnHome = useLocation({ select: (loc) => loc.pathname === "/" });
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const { settings: appSettings } = useAppSettings();
  const wsConnectionState = useWsConnectionState();
  const wsInteractionBlocked = isWsInteractionBlocked(wsConnectionState.phase);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [collapsedArchivedSectionsByProject, setCollapsedArchivedSectionsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const workflowDialogProjectId = useWorkflowCreateDialogStore((state) => state.projectId);
  const openWorkflowCreateDialog = useWorkflowCreateDialogStore((state) => state.open);
  const closeWorkflowCreateDialog = useWorkflowCreateDialogStore((state) => state.close);
  const [workflowExpandedById, setWorkflowExpandedById] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [sidebarHoverFreezeSnapshot, setSidebarHoverFreezeSnapshot] =
    useState<SidebarHoverFreezeSnapshot | null>(null);
  const archivedSectionsInitializedRef = useRef(false);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const sidebarHoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const firstProjectId = projects[0]?.id ?? null;
  const mostRecentProjectId = useMemo(
    () =>
      getMostRecentProject(projects, threads, planningWorkflows, codeReviewWorkflows)?.id ?? null,
    [codeReviewWorkflows, planningWorkflows, projects, threads],
  );
  const shouldBrowseForProjectImmediately = isElectron;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingApprovals(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const pendingUserInputByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingUserInputs(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const persistedThreadIds = useMemo(() => new Set(threads.map((thread) => thread.id)), [threads]);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions({
        cwd,
        autoRefresh: appSettings.enableGitStatusAutoRefresh,
        staleTimeMs: 30_000,
        refetchIntervalMs: 60_000,
      }),
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);
  const createSidebarHoverFreezeSnapshot = useCallback((): SidebarHoverFreezeSnapshot => {
    const workflowKeysByProjectId: Record<string, readonly string[]> = {};
    const workflowThreadIdsByWorkflowKey: Record<string, readonly ThreadId[]> = {};
    const activeThreadIdsByProjectId: Record<string, readonly ThreadId[]> = {};
    const archivedItemKeysByProjectId: Record<string, readonly string[]> = {};

    for (const project of projects) {
      const lists = buildProjectSidebarLists({
        project,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
        draftThread: getDraftThreadByProjectId(project.id),
      });

      workflowKeysByProjectId[project.id] = lists.projectWorkflows.map(workflowEntryKey);
      activeThreadIdsByProjectId[project.id] = lists.activeThreads.map((thread) => thread.id);
      archivedItemKeysByProjectId[project.id] = lists.archivedSidebarItems.map((item) => item.key);

      for (const [workflowKey, workflowThreads] of lists.workflowThreadsByKey) {
        workflowThreadIdsByWorkflowKey[workflowKey] = workflowThreads.map((thread) => thread.id);
      }
    }

    return {
      workflowKeysByProjectId,
      workflowThreadIdsByWorkflowKey,
      activeThreadIdsByProjectId,
      archivedItemKeysByProjectId,
    };
  }, [codeReviewWorkflows, getDraftThreadByProjectId, planningWorkflows, projects, threads]);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      setProjectExpanded(projectId, true);
      return createProjectBackedDraftThread(projectId, options).then(() => undefined);
    },
    [createProjectBackedDraftThread, setProjectExpanded],
  );
  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = getMostRecentThreadForProject(
        projectId,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
      );
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [codeReviewWorkflows, navigate, planningWorkflows, threads],
  );
  const toggleWorkflowCollapsed = useCallback((workflowId: string, fallbackExpanded: boolean) => {
    setWorkflowExpandedById((current) =>
      toggleWorkflowThreadListExpansion({
        workflowId,
        workflowExpandedById: current,
        fallbackExpanded,
      }),
    );
  }, []);
  const handleWorkflowCreated = useCallback((workflowId: string) => {
    setWorkflowExpandedById((current) => {
      if (current[workflowId] === true) {
        return current;
      }
      return {
        ...current,
        [workflowId]: true,
      };
    });
  }, []);
  const archiveWorkflow = useCallback(
    async (
      workflowId: PlanningWorkflowId | CodeReviewWorkflowId,
      workflowTitle: string,
      workflowType: SidebarWorkflowEntry["type"],
    ) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Workflow actions are unavailable.",
        });
        return;
      }
      const confirmed = await api.dialogs.confirm(`Archive workflow "${workflowTitle}"?`);
      if (!confirmed) {
        return;
      }
      try {
        if (workflowType === "planning") {
          await api.orchestration.archiveWorkflow({
            workflowId: workflowId as PlanningWorkflowId,
          });
        } else {
          await api.orchestration.archiveCodeReviewWorkflow({
            workflowId: workflowId as CodeReviewWorkflowId,
          });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive workflow",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [],
  );

  const unarchiveWorkflow = useCallback(
    async (
      workflowId: PlanningWorkflowId | CodeReviewWorkflowId,
      workflowType: SidebarWorkflowEntry["type"],
    ) => {
      const api = readNativeApi();
      if (!api) {
        return;
      }

      try {
        if (workflowType === "planning") {
          await api.orchestration.unarchiveWorkflow({
            workflowId: workflowId as PlanningWorkflowId,
          });
        } else {
          await api.orchestration.unarchiveCodeReviewWorkflow({
            workflowId: workflowId as CodeReviewWorkflowId,
          });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to unarchive workflow",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch((error) => {
          console.warn("Failed to open the new thread after creating a project", error);
        });
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      appSettings.defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => (current === threadId ? null : current));
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const cancelProjectRename = useCallback(() => {
    setRenamingProjectId(null);
  }, []);

  const commitProjectRename = useCallback(
    async (projectId: ProjectId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingProjectId((current) => (current === projectId ? null : current));
      };
      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        // Treat empty as cancel rather than an explicit rename-to-empty error,
        // matching the thread rename flow. See `InlineTitleEditor` onBlur.
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      // Keep the inline editor mounted until dispatch resolves so the user
      // isn't left staring at the old name during a pending rename (or after
      // an error). Collapse only after the command round-trips.
      finishRename();
    },
    [],
  );

  const changeProjectWorkspaceRoot = useCallback(
    async (project: Pick<Project, "id" | "cwd" | "name">) => {
      const api = readNativeApi();
      if (!api) {
        return;
      }

      let nextWorkspaceRoot: string | null = null;
      try {
        if (window.desktopBridge) {
          nextWorkspaceRoot = await api.dialogs.pickFolder();
        } else {
          nextWorkspaceRoot = window.prompt(
            `Enter the new project path for "${project.name}"`,
            project.cwd,
          );
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to choose project path",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      const trimmedWorkspaceRoot = nextWorkspaceRoot?.trim();
      if (!trimmedWorkspaceRoot || trimmedWorkspaceRoot === project.cwd) {
        return;
      }

      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: project.id,
          workspaceRoot: trimmedWorkspaceRoot,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to change project path",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [],
  );

  const setThreadArchived = useCallback(async (threadId: ThreadId, archived: boolean) => {
    const api = readNativeApi();
    if (!api) return;

    try {
      await api.orchestration.dispatchCommand({
        type: archived ? "thread.archive" : "thread.unarchive",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: archived ? "Failed to archive thread" : "Failed to unarchive thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, []);

  /**
   * Delete a single thread: stop session, close terminal, dispatch delete,
   * clean up drafts/state, and optionally remove orphaned worktree.
   * Callers handle thread-level confirmation; this still prompts for worktree removal.
   */
  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadProject = projects.find((project) => project.id === thread.projectId);
      // When bulk-deleting, exclude the other threads being deleted so
      // getOrphanedWorktreePathForThread correctly detects that no surviving
      // threads will reference this worktree.
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((t) => t.id === threadId || !deletedIds.has(t.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch((error) => {
            console.warn("Failed to stop the thread session before deletion", error);
          });
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed
      }

      const allDeletedIds = deletedIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId =
        sortThreadsByActivity(
          threads.filter(
            (entry) =>
              entry.id !== threadId && !allDeletedIds.has(entry.id) && !isArchivedThread(entry),
          ),
        )[0]?.id ?? null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      threads,
    ],
  );

  const removeProjectWithThreads = useCallback(
    async (project: Project, projectThreads: ReadonlyArray<Thread>): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;

      const message =
        projectThreads.length === 0
          ? `Remove project "${project.name}"?`
          : [
              `Remove project "${project.name}" and delete ${projectThreads.length} thread${
                projectThreads.length === 1 ? "" : "s"
              }?`,
              "",
              "Thread sessions, terminal history, and draft state will be cleaned up first.",
            ].join("\n");
      const confirmed = await api.dialogs.confirm(message);
      if (!confirmed) return;

      try {
        const deletedThreadIds = new Set(projectThreads.map((thread) => thread.id));
        for (const thread of projectThreads) {
          await deleteThread(thread.id, { deletedThreadIds });
        }

        clearProjectDraftThreadId(project.id);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId: project.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId: project.id, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [clearProjectDraftThreadId, deleteThread],
  );

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          {
            id: thread.archivedAt === null ? "archive" : "unarchive",
            label: thread.archivedAt === null ? "Archive" : "Unarchive",
          },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        return;
      }

      if (clicked === "archive") {
        await setThreadArchived(threadId, true);
        return;
      }

      if (clicked === "unarchive") {
        await setThreadArchived(threadId, false);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadId);
    },
    [
      appSettings.confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      projectCwdById,
      setThreadArchived,
      threads,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  const handleThreadClick = useCallback(
    (
      event: MouseEvent,
      threadId: ThreadId,
      orderedProjectThreadIds: readonly ThreadId[],
      options?: { isDraft?: boolean },
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const isDraft = options?.isDraft === true;

      if (!isDraft && isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (!isDraft && isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0 || isDraft) {
        clearSelection();
      }
      if (!isDraft) {
        setSelectionAnchor(threadId);
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "change-path", label: "Change project path..." },
          { id: "rename", label: "Rename project" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;
      if (clicked === "change-path") {
        await changeProjectWorkspaceRoot(project);
        return;
      }
      if (clicked === "rename") {
        setRenamingProjectId(projectId);
        return;
      }
      if (clicked !== "delete") return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete the child threads first, or delete them and remove the project now.",
          timeout: 0,
          actionProps: {
            children: "Delete anyway",
            onClick: () => {
              void removeProjectWithThreads(project, projectThreads);
            },
          },
        });
        return;
      }

      await removeProjectWithThreads(project, []);
    },
    [changeProjectWorkspaceRoot, projects, removeProjectWithThreads, threads],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback((_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  }, []);

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Global window shortcuts can overlap with focused overlays and widgets.
      // Respect the first consumer so later listeners do not double-handle it.
      if (event.defaultPrevented) {
        return;
      }
      if (wsInteractionBlocked) {
        return;
      }

      if (event.key === "Escape" && selectedThreadIds.size > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const activeThread = routeThreadId
        ? threads.find((thread) => thread.id === routeThreadId)
        : undefined;
      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadId
            ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
            : false,
        },
      });
      if (!command) return;

      const projectId =
        activeThread?.projectId ??
        activeDraftThread?.projectId ??
        mostRecentProjectId ??
        firstProjectId;

      if (command === "workflow.new") {
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        openWorkflowCreateDialog(projectId);
        return;
      }

      if (command === "chat.newLocal") {
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId);
        return;
      }

      if (command !== "chat.new") return;
      if (!projectId) return;
      event.preventDefault();
      event.stopPropagation();
      if (appSettings.defaultThreadEnvMode === "worktree") {
        void handleNewThread(projectId, { envMode: "worktree" });
        return;
      }
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
      });
    };
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [
    appSettings.defaultThreadEnvMode,
    clearSelection,
    firstProjectId,
    getDraftThread,
    handleNewThread,
    keybindings,
    mostRecentProjectId,
    openWorkflowCreateDialog,
    routeThreadId,
    selectedThreadIds.size,
    terminalStateByThreadId,
    threads,
    wsInteractionBlocked,
  ]);

  useEffect(() => {
    const anchor = sidebarHoverAnchorRef.current;
    const sidebarContainer = anchor?.closest<HTMLElement>("[data-slot='sidebar-container']");
    if (!sidebarContainer) {
      return;
    }

    const handleMouseEnter = () => {
      setSidebarHoverFreezeSnapshot(createSidebarHoverFreezeSnapshot());
    };
    const handleMouseLeave = () => {
      setSidebarHoverFreezeSnapshot(null);
    };

    sidebarContainer.addEventListener("mouseenter", handleMouseEnter);
    sidebarContainer.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      sidebarContainer.removeEventListener("mouseenter", handleMouseEnter);
      sidebarContainer.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [createSidebarHoverFreezeSnapshot]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch((error) => {
        console.warn("Failed to fetch the desktop update state", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const desktopUpdateButtonClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-emerald-500"
      : desktopUpdateState?.status === "downloading"
        ? "text-sky-400"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-rose-500 animate-pulse"
          : "text-amber-500 animate-pulse";
  const newThreadShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );
  const workflowShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "workflow.new"),
    [keybindings],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback(
    (projectId: ProjectId, bucket: SidebarThreadBucket) => {
      setExpandedThreadListsByProject((current) => {
        const key = threadBucketExpansionKey(projectId, bucket);
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      });
    },
    [],
  );

  const collapseThreadListForProject = useCallback(
    (projectId: ProjectId, bucket: SidebarThreadBucket) => {
      setExpandedThreadListsByProject((current) => {
        const key = threadBucketExpansionKey(projectId, bucket);
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
    [],
  );

  const toggleArchivedSectionForProject = useCallback((projectId: ProjectId) => {
    setCollapsedArchivedSectionsByProject((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (archivedSectionsInitializedRef.current || !threadsHydrated) {
      return;
    }

    archivedSectionsInitializedRef.current = true;
    setCollapsedArchivedSectionsByProject(
      new Set([
        ...threads.filter((thread) => isArchivedThread(thread)).map((thread) => thread.projectId),
        ...planningWorkflows
          .filter((workflow) => isArchivedWorkflow(workflow))
          .map((workflow) => workflow.projectId),
        ...codeReviewWorkflows
          .filter((workflow) => isArchivedWorkflow(workflow))
          .map((workflow) => workflow.projectId),
      ]),
    );
  }, [codeReviewWorkflows, planningWorkflows, threads, threadsHydrated]);

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-1 ml-1 cursor-pointer">
              <F5Wordmark />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                Code
              </span>
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL}
              </span>
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return (
    <div ref={sidebarHoverAnchorRef} className="contents">
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
            {wordmark}
            {showDesktopUpdateButton && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={`inline-flex size-7 ml-auto mt-1.5 items-center justify-center rounded-md text-muted-foreground transition-colors ${desktopUpdateButtonInteractivityClasses} ${desktopUpdateButtonClasses}`}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            )}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0">
        {!isOnHome && !isOnSettings ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  onClick={() => void navigate({ to: "/" })}
                >
                  <HomeIcon className="size-3.5" />
                  <span className="text-xs">Home</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    aria-pressed={shouldShowProjectPathEntry}
                    className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleStartAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>

          {shouldShowProjectPathEntry && (
            <div className="mb-2 px-1">
              {isElectron && (
                <button
                  type="button"
                  className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void handlePickFolder()}
                  disabled={isPickingFolder || isAddingProject}
                >
                  <FolderIcon className="size-3.5" />
                  {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                </button>
              )}
              <div className="flex gap-1.5">
                <input
                  ref={addProjectInputRef}
                  className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-base text-foreground placeholder:text-muted-foreground/40 focus:outline-none sm:text-xs ${
                    addProjectError
                      ? "border-red-500/70 focus:border-red-500"
                      : "border-border focus:border-ring"
                  }`}
                  placeholder="/path/to/project"
                  value={newCwd}
                  onChange={(event) => {
                    setNewCwd(event.target.value);
                    setAddProjectError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddProject();
                    if (event.key === "Escape") {
                      setAddingProject(false);
                      setAddProjectError(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                  onClick={handleAddProject}
                  disabled={!canAddProject}
                >
                  {isAddingProject ? "Adding..." : "Add"}
                </button>
              </div>
              {addProjectError && (
                <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                  {addProjectError}
                </p>
              )}
              <div className="mt-1.5 px-0.5">
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  onClick={() => {
                    setAddingProject(false);
                    setAddProjectError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu>
              <SortableContext
                items={projects.map((project) => project.id)}
                strategy={verticalListSortingStrategy}
              >
                {projects.map((project) => {
                  const persistedDraftThread = getDraftThreadByProjectId(project.id);
                  const sidebarLists = buildProjectSidebarLists({
                    project,
                    threads,
                    planningWorkflows,
                    codeReviewWorkflows,
                    draftThread: persistedDraftThread,
                  });
                  const projectWorkflows = reconcileFrozenOrder({
                    items: sidebarLists.projectWorkflows,
                    getKey: workflowEntryKey,
                    frozenOrder: sidebarHoverFreezeSnapshot?.workflowKeysByProjectId[project.id],
                  });
                  const workflowThreadsByWorkflowId = new Map(
                    projectWorkflows.map((entry) => {
                      const workflowKey = workflowEntryKey(entry);
                      const workflowThreads = reconcileFrozenOrder({
                        items: sidebarLists.workflowThreadsByKey.get(workflowKey) ?? [],
                        getKey: (thread) => thread.id,
                        frozenOrder:
                          sidebarHoverFreezeSnapshot?.workflowThreadIdsByWorkflowKey[workflowKey],
                      });
                      return [entry.workflow.id, workflowThreads] as const;
                    }),
                  );
                  const activeThreads = reconcileFrozenOrder({
                    items: sidebarLists.activeThreads,
                    getKey: (thread) => thread.id,
                    frozenOrder: sidebarHoverFreezeSnapshot?.activeThreadIdsByProjectId[project.id],
                    prependUnseenKeys: sidebarLists.projectDraftThreadId
                      ? [sidebarLists.projectDraftThreadId]
                      : [],
                  });
                  const archivedSidebarItems = reconcileFrozenOrder({
                    items: sidebarLists.archivedSidebarItems,
                    getKey: (item) => item.key,
                    frozenOrder:
                      sidebarHoverFreezeSnapshot?.archivedItemKeysByProjectId[project.id],
                  });
                  const projectDraftThreadId = sidebarLists.projectDraftThreadId;
                  const activeExpanded = expandedThreadListsByProject.has(
                    threadBucketExpansionKey(project.id, "active"),
                  );
                  const archivedExpanded = expandedThreadListsByProject.has(
                    threadBucketExpansionKey(project.id, "archived"),
                  );
                  const archivedSectionCollapsed = collapsedArchivedSectionsByProject.has(
                    project.id,
                  );
                  const visibleActiveThreads = getVisibleThreadsWithPinnedDraft({
                    threads: activeThreads,
                    expanded: activeExpanded || activeThreads.length <= THREAD_PREVIEW_LIMIT,
                    previewLimit: THREAD_PREVIEW_LIMIT,
                    draftThreadId: projectDraftThreadId,
                  });
                  const visibleArchivedItems =
                    archivedExpanded || archivedSidebarItems.length <= THREAD_PREVIEW_LIMIT
                      ? archivedSidebarItems
                      : archivedSidebarItems.slice(0, THREAD_PREVIEW_LIMIT);
                  const hasHiddenActiveThreads = activeThreads.length > THREAD_PREVIEW_LIMIT;
                  const hasHiddenArchivedItems = archivedSidebarItems.length > THREAD_PREVIEW_LIMIT;
                  const orderedProjectThreadIds = [
                    ...visibleActiveThreads
                      .filter(
                        (thread) =>
                          !isDraftThreadId(thread.id, draftThreadsByThreadId, persistedThreadIds),
                      )
                      .map((thread) => thread.id),
                    ...(!archivedSectionCollapsed
                      ? visibleArchivedItems.flatMap((item) =>
                          item.kind === "thread" ? [item.thread.id] : [],
                        )
                      : []),
                  ];

                  return (
                    <SortableProjectItem key={project.id} projectId={project.id}>
                      {(dragHandleProps) => (
                        <Collapsible className="group/collapsible" open={project.expanded}>
                          <div className="group/project-header relative">
                            <SidebarMenuButton
                              size="sm"
                              className="gap-2 px-2 py-1.5 text-left cursor-grab active:cursor-grabbing hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                              {...dragHandleProps.attributes}
                              {...dragHandleProps.listeners}
                              onPointerDownCapture={handleProjectTitlePointerDownCapture}
                              onClick={(event) => handleProjectTitleClick(event, project.id)}
                              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                void handleProjectContextMenu(project.id, {
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                            >
                              <ChevronRightIcon
                                className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                                  project.expanded ? "rotate-90" : ""
                                }`}
                              />
                              <ProjectFavicon cwd={project.cwd} />
                              {renamingProjectId === project.id ? (
                                <InlineTitleEditor
                                  initialValue={project.name}
                                  ariaLabel="Rename project"
                                  className="flex-1 text-xs font-medium text-foreground/90"
                                  onCommit={(value) =>
                                    void commitProjectRename(project.id, value, project.name)
                                  }
                                  onCancel={cancelProjectRename}
                                />
                              ) : (
                                <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                                  {project.name}
                                </span>
                              )}
                            </SidebarMenuButton>
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
                                    className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void handleNewThread(project.id, {
                                        envMode: resolveSidebarNewThreadEnvMode({
                                          defaultEnvMode: appSettings.defaultThreadEnvMode,
                                        }),
                                      });
                                    }}
                                  >
                                    <SquarePenIcon className="size-3.5" />
                                  </SidebarMenuAction>
                                }
                              />
                              <TooltipPopup side="top">
                                {newThreadShortcutLabel
                                  ? `New thread (${newThreadShortcutLabel})`
                                  : "New thread"}
                              </TooltipPopup>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <SidebarMenuAction
                                    render={
                                      <button
                                        type="button"
                                        aria-label={`Create workflow in ${project.name}`}
                                      />
                                    }
                                    showOnHover
                                    className="top-1 right-7 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      openWorkflowCreateDialog(project.id);
                                    }}
                                  >
                                    <RocketIcon className="size-3.5" />
                                  </SidebarMenuAction>
                                }
                              />
                              <TooltipPopup side="top">
                                {workflowShortcutLabel
                                  ? `New workflow (${workflowShortcutLabel})`
                                  : "New workflow"}
                              </TooltipPopup>
                            </Tooltip>
                          </div>

                          <CollapsibleContent keepMounted>
                            <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 px-1.5 py-0">
                              {projectWorkflows.map(({ workflow, type }) => {
                                const isWorkflowActive =
                                  type === "planning"
                                    ? pathname === `/workflow/${workflow.id}` ||
                                      pathname === `/_chat/workflow/${workflow.id}`
                                    : pathname === `/code-review/${workflow.id}` ||
                                      pathname === `/_chat/code-review/${workflow.id}`;
                                const workflowThreads =
                                  workflowThreadsByWorkflowId.get(workflow.id) ?? [];
                                const orderedWorkflowThreadIds = workflowThreads.map(
                                  (thread) => thread.id,
                                );
                                const defaultWorkflowExpanded = resolveWorkflowThreadListExpanded({
                                  expandByDefault: appSettings.expandWorkflowThreadsByDefault,
                                  activeThreadId: routeThreadId,
                                  workflowThreadIds: orderedWorkflowThreadIds,
                                });
                                const workflowExpanded = resolveWorkflowThreadListExpanded({
                                  overrideExpanded: workflowExpandedById[workflow.id],
                                  expandByDefault: appSettings.expandWorkflowThreadsByDefault,
                                  activeThreadId: routeThreadId,
                                  workflowThreadIds: orderedWorkflowThreadIds,
                                });
                                const workflowCollapsed = !workflowExpanded;
                                return (
                                  <SidebarMenuSubItem
                                    key={workflow.id}
                                    className="group/workflow-row relative w-full"
                                  >
                                    <SidebarMenuSubButton
                                      render={<div role="button" tabIndex={0} />}
                                      size="sm"
                                      isActive={isWorkflowActive}
                                      className="gap-2"
                                      onClick={() => {
                                        void navigate({
                                          to:
                                            type === "planning"
                                              ? "/workflow/$workflowId"
                                              : "/code-review/$workflowId",
                                          params: { workflowId: workflow.id },
                                        });
                                      }}
                                    >
                                      <button
                                        type="button"
                                        aria-label={
                                          workflowCollapsed
                                            ? `Expand ${workflow.title}`
                                            : `Collapse ${workflow.title}`
                                        }
                                        className="inline-flex items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground"
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          toggleWorkflowCollapsed(
                                            workflow.id,
                                            defaultWorkflowExpanded,
                                          );
                                        }}
                                      >
                                        <ChevronRightIcon
                                          className={`size-3 shrink-0 transition-transform ${
                                            workflowCollapsed ? "" : "rotate-90"
                                          }`}
                                        />
                                      </button>
                                      <RocketIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        {type === "planning" ? "Feature" : "Review"}
                                      </span>
                                      <span className="truncate text-xs font-medium">
                                        {workflow.title}
                                      </span>
                                      <button
                                        type="button"
                                        aria-label={`Archive ${workflow.title}`}
                                        className="ml-auto inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground/60 opacity-0 transition group-hover/workflow-row:opacity-100 hover:text-foreground"
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          void archiveWorkflow(workflow.id, workflow.title, type);
                                        }}
                                      >
                                        <ArchiveIcon className="size-3" />
                                      </button>
                                    </SidebarMenuSubButton>
                                    {!workflowCollapsed && workflowThreads.length > 0 ? (
                                      <SidebarMenuSub className="mx-0 mt-0.5 mb-0 w-full translate-x-0 gap-0.5 border-l-0 pl-4">
                                        {workflowThreads.map((thread) => {
                                          const isActive = routeThreadId === thread.id;
                                          const isSelected = selectedThreadIds.has(thread.id);
                                          const threadStatus = resolveThreadStatusPill({
                                            thread,
                                            hasPendingApprovals:
                                              pendingApprovalByThreadId.get(thread.id) === true,
                                            hasPendingUserInput:
                                              pendingUserInputByThreadId.get(thread.id) === true,
                                          });
                                          const prStatus = prStatusIndicator(
                                            prByThreadId.get(thread.id) ?? null,
                                          );
                                          const terminalStatus = terminalStatusFromRunningIds(
                                            selectThreadTerminalState(
                                              terminalStateByThreadId,
                                              thread.id,
                                            ).runningTerminalIds,
                                          );
                                          return (
                                            <SidebarMenuSubItem
                                              key={thread.id}
                                              className="group/thread-row w-full"
                                              data-thread-item
                                            >
                                              <SidebarMenuSubButton
                                                render={<div role="button" tabIndex={0} />}
                                                size="sm"
                                                isActive={isActive}
                                                className={resolveThreadRowClassName({
                                                  isActive,
                                                  isSelected,
                                                })}
                                                onClick={(event) => {
                                                  handleThreadClick(
                                                    event,
                                                    thread.id,
                                                    orderedWorkflowThreadIds,
                                                    { isDraft: false },
                                                  );
                                                }}
                                                onKeyDown={(event) => {
                                                  if (event.key !== "Enter" && event.key !== " ") {
                                                    return;
                                                  }
                                                  event.preventDefault();
                                                  if (selectedThreadIds.size > 0) {
                                                    clearSelection();
                                                  }
                                                  setSelectionAnchor(thread.id);
                                                  void navigate({
                                                    to: "/$threadId",
                                                    params: { threadId: thread.id },
                                                  });
                                                }}
                                                onContextMenu={(event) => {
                                                  event.preventDefault();
                                                  if (
                                                    selectedThreadIds.size > 0 &&
                                                    selectedThreadIds.has(thread.id)
                                                  ) {
                                                    void handleMultiSelectContextMenu({
                                                      x: event.clientX,
                                                      y: event.clientY,
                                                    });
                                                  } else {
                                                    if (selectedThreadIds.size > 0) {
                                                      clearSelection();
                                                    }
                                                    void handleThreadContextMenu(thread.id, {
                                                      x: event.clientX,
                                                      y: event.clientY,
                                                    });
                                                  }
                                                }}
                                              >
                                                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                                  {prStatus && (
                                                    <Tooltip>
                                                      <TooltipTrigger
                                                        render={
                                                          <button
                                                            type="button"
                                                            aria-label={prStatus.tooltip}
                                                            className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                                            onClick={(event) => {
                                                              openPrLink(event, prStatus.url);
                                                            }}
                                                          >
                                                            <GitPullRequestIcon className="size-3" />
                                                          </button>
                                                        }
                                                      />
                                                      <TooltipPopup side="top">
                                                        {prStatus.tooltip}
                                                      </TooltipPopup>
                                                    </Tooltip>
                                                  )}
                                                  {threadStatus ? (
                                                    <ThreadStatusPillBadge
                                                      pill={threadStatus}
                                                      hideLabelBelowMd
                                                    />
                                                  ) : null}
                                                  <Tooltip>
                                                    <TooltipTrigger
                                                      render={
                                                        <span className="min-w-0 flex-1 truncate text-xs">
                                                          {type === "planning"
                                                            ? workflowThreadDisplayTitle(
                                                                workflow,
                                                                thread.title,
                                                              )
                                                            : thread.title}
                                                        </span>
                                                      }
                                                    />
                                                    <TooltipPopup
                                                      side="top"
                                                      className="max-w-80 whitespace-normal leading-tight"
                                                    >
                                                      {type === "planning"
                                                        ? workflowThreadDisplayTitle(
                                                            workflow,
                                                            thread.title,
                                                          )
                                                        : thread.title}
                                                    </TooltipPopup>
                                                  </Tooltip>
                                                </div>
                                                <ThreadRowTrailingMeta
                                                  lastInteractionAt={thread.lastInteractionAt}
                                                  terminalStatus={terminalStatus}
                                                  isHighlighted={isActive || isSelected}
                                                />
                                              </SidebarMenuSubButton>
                                            </SidebarMenuSubItem>
                                          );
                                        })}
                                      </SidebarMenuSub>
                                    ) : null}
                                  </SidebarMenuSubItem>
                                );
                              })}
                              {visibleActiveThreads.map((thread) => {
                                const isDraftThread = isDraftThreadId(
                                  thread.id,
                                  draftThreadsByThreadId,
                                  persistedThreadIds,
                                );
                                const isActive = routeThreadId === thread.id;
                                const isSelected =
                                  !isDraftThread && selectedThreadIds.has(thread.id);
                                const isHighlighted = isActive || isSelected;
                                const threadStatus = resolveThreadStatusPill({
                                  thread,
                                  hasPendingApprovals:
                                    pendingApprovalByThreadId.get(thread.id) === true,
                                  hasPendingUserInput:
                                    pendingUserInputByThreadId.get(thread.id) === true,
                                });
                                const prStatus = prStatusIndicator(
                                  prByThreadId.get(thread.id) ?? null,
                                );
                                const terminalStatus = terminalStatusFromRunningIds(
                                  selectThreadTerminalState(terminalStateByThreadId, thread.id)
                                    .runningTerminalIds,
                                );

                                return (
                                  <SidebarMenuSubItem
                                    key={thread.id}
                                    className="group/thread-row w-full"
                                    data-thread-item
                                  >
                                    <SidebarMenuSubButton
                                      render={<div role="button" tabIndex={0} />}
                                      size="sm"
                                      isActive={isActive}
                                      className={resolveThreadRowClassName({
                                        isActive,
                                        isSelected,
                                      })}
                                      onClick={(event) => {
                                        handleThreadClick(
                                          event,
                                          thread.id,
                                          orderedProjectThreadIds,
                                          { isDraft: isDraftThread },
                                        );
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key !== "Enter" && event.key !== " ") return;
                                        event.preventDefault();
                                        if (selectedThreadIds.size > 0 || isDraftThread) {
                                          clearSelection();
                                        }
                                        if (!isDraftThread) {
                                          setSelectionAnchor(thread.id);
                                        }
                                        void navigate({
                                          to: "/$threadId",
                                          params: { threadId: thread.id },
                                        });
                                      }}
                                      onContextMenu={(event) => {
                                        event.preventDefault();
                                        if (isDraftThread) {
                                          if (selectedThreadIds.size > 0) {
                                            clearSelection();
                                          }
                                          return;
                                        }
                                        if (
                                          selectedThreadIds.size > 0 &&
                                          selectedThreadIds.has(thread.id)
                                        ) {
                                          void handleMultiSelectContextMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                          });
                                        } else {
                                          if (selectedThreadIds.size > 0) {
                                            clearSelection();
                                          }
                                          void handleThreadContextMenu(thread.id, {
                                            x: event.clientX,
                                            y: event.clientY,
                                          });
                                        }
                                      }}
                                    >
                                      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                        {prStatus && (
                                          <Tooltip>
                                            <TooltipTrigger
                                              render={
                                                <button
                                                  type="button"
                                                  aria-label={prStatus.tooltip}
                                                  className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                                  onClick={(event) => {
                                                    openPrLink(event, prStatus.url);
                                                  }}
                                                >
                                                  <GitPullRequestIcon className="size-3" />
                                                </button>
                                              }
                                            />
                                            <TooltipPopup side="top">
                                              {prStatus.tooltip}
                                            </TooltipPopup>
                                          </Tooltip>
                                        )}
                                        {threadStatus ? (
                                          <ThreadStatusPillBadge
                                            pill={threadStatus}
                                            hideLabelBelowMd
                                          />
                                        ) : null}
                                        {!isDraftThread && renamingThreadId === thread.id ? (
                                          <InlineTitleEditor
                                            initialValue={thread.title}
                                            onCommit={(nextValue) => {
                                              void commitRename(thread.id, nextValue, thread.title);
                                            }}
                                            onCancel={cancelRename}
                                          />
                                        ) : (
                                          <SidebarThreadTitle thread={thread} />
                                        )}
                                      </div>
                                      <ThreadRowTrailingMeta
                                        lastInteractionAt={thread.lastInteractionAt}
                                        terminalStatus={terminalStatus}
                                        isHighlighted={isHighlighted}
                                        action={
                                          !isDraftThread
                                            ? {
                                                label: "Archive",
                                                ariaLabel: `Archive ${thread.title}`,
                                                onClick: () => {
                                                  void setThreadArchived(thread.id, true);
                                                },
                                              }
                                            : undefined
                                        }
                                      />
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                );
                              })}

                              {hasHiddenActiveThreads && !activeExpanded && (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                    onClick={() => {
                                      expandThreadListForProject(project.id, "active");
                                    }}
                                  >
                                    <span>Show more</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}
                              {hasHiddenActiveThreads && activeExpanded && (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                    onClick={() => {
                                      collapseThreadListForProject(project.id, "active");
                                    }}
                                  >
                                    <span>Show less</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}

                              {archivedSidebarItems.length > 0 ? (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    aria-expanded={!archivedSectionCollapsed}
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start gap-1 px-2 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/45 hover:bg-accent hover:text-muted-foreground/70"
                                    onClick={() => {
                                      toggleArchivedSectionForProject(project.id);
                                    }}
                                  >
                                    <ChevronRightIcon
                                      className={`size-3 shrink-0 transition-transform duration-150 ${
                                        archivedSectionCollapsed ? "" : "rotate-90"
                                      }`}
                                    />
                                    <span>Archived</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ) : null}

                              {!archivedSectionCollapsed &&
                                visibleArchivedItems.map((item) => {
                                  if (item.kind === "workflow") {
                                    const isActive = isWorkflowRouteActive(
                                      pathname,
                                      item.workflow.id,
                                      item.type,
                                    );

                                    return (
                                      <SidebarMenuSubItem
                                        key={item.key}
                                        className="group/archived-workflow-row w-full"
                                      >
                                        <SidebarMenuSubButton
                                          render={<div role="button" tabIndex={0} />}
                                          size="sm"
                                          isActive={isActive}
                                          className={`h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left select-none hover:bg-accent hover:text-foreground focus-visible:ring-0 ${
                                            isActive
                                              ? "bg-accent/85 text-foreground font-medium dark:bg-accent/55"
                                              : "text-muted-foreground"
                                          }`}
                                          onClick={() => {
                                            void navigate({
                                              to:
                                                item.type === "planning"
                                                  ? "/workflow/$workflowId"
                                                  : "/code-review/$workflowId",
                                              params: { workflowId: item.workflow.id },
                                            });
                                          }}
                                          onKeyDown={(event) => {
                                            if (event.key !== "Enter" && event.key !== " ") {
                                              return;
                                            }
                                            event.preventDefault();
                                            void navigate({
                                              to:
                                                item.type === "planning"
                                                  ? "/workflow/$workflowId"
                                                  : "/code-review/$workflowId",
                                              params: { workflowId: item.workflow.id },
                                            });
                                          }}
                                        >
                                          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                            <RocketIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                              {item.type === "planning" ? "Feature" : "Review"}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-xs">
                                              {item.workflow.title}
                                            </span>
                                          </div>
                                          <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                            <div className="shrink-0 text-right">
                                              <span
                                                className={`block text-[10px] group-hover/archived-workflow-row:hidden group-focus-within/archived-workflow-row:hidden ${
                                                  isActive
                                                    ? "text-foreground/65"
                                                    : "text-muted-foreground/40"
                                                }`}
                                              >
                                                {formatRelativeTimeLabel(item.workflow.updatedAt)}
                                              </span>
                                              <button
                                                type="button"
                                                aria-label={`Unarchive ${item.workflow.title}`}
                                                className={`hidden whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/archived-workflow-row:inline-flex group-focus-within/archived-workflow-row:inline-flex ${
                                                  isActive
                                                    ? "text-foreground/70"
                                                    : "text-muted-foreground/70"
                                                }`}
                                                onMouseDown={(event) => {
                                                  event.stopPropagation();
                                                }}
                                                onClick={(event) => {
                                                  event.preventDefault();
                                                  event.stopPropagation();
                                                  void unarchiveWorkflow(
                                                    item.workflow.id,
                                                    item.type,
                                                  );
                                                }}
                                                onKeyDown={(event) => {
                                                  event.stopPropagation();
                                                }}
                                              >
                                                Unarchive
                                              </button>
                                            </div>
                                          </div>
                                        </SidebarMenuSubButton>
                                      </SidebarMenuSubItem>
                                    );
                                  }

                                  const thread = item.thread;
                                  const isActive = routeThreadId === thread.id;
                                  const isSelected = selectedThreadIds.has(thread.id);
                                  const isHighlighted = isActive || isSelected;
                                  const threadStatus = resolveThreadStatusPill({
                                    thread,
                                    hasPendingApprovals:
                                      pendingApprovalByThreadId.get(thread.id) === true,
                                    hasPendingUserInput:
                                      pendingUserInputByThreadId.get(thread.id) === true,
                                  });
                                  const prStatus = prStatusIndicator(
                                    prByThreadId.get(thread.id) ?? null,
                                  );
                                  const terminalStatus = terminalStatusFromRunningIds(
                                    selectThreadTerminalState(terminalStateByThreadId, thread.id)
                                      .runningTerminalIds,
                                  );

                                  return (
                                    <SidebarMenuSubItem
                                      key={item.key}
                                      className="group/thread-row w-full"
                                      data-thread-item
                                    >
                                      <SidebarMenuSubButton
                                        render={<div role="button" tabIndex={0} />}
                                        size="sm"
                                        isActive={isActive}
                                        className={`h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left select-none hover:bg-accent hover:text-foreground focus-visible:ring-0 ${
                                          isSelected
                                            ? "bg-primary/15 text-foreground dark:bg-primary/10"
                                            : isActive
                                              ? "bg-accent/85 text-foreground font-medium dark:bg-accent/55"
                                              : "text-muted-foreground"
                                        }`}
                                        onClick={(event) => {
                                          handleThreadClick(
                                            event,
                                            thread.id,
                                            orderedProjectThreadIds,
                                          );
                                        }}
                                        onKeyDown={(event) => {
                                          if (event.key !== "Enter" && event.key !== " ") return;
                                          event.preventDefault();
                                          if (selectedThreadIds.size > 0) {
                                            clearSelection();
                                          }
                                          setSelectionAnchor(thread.id);
                                          void navigate({
                                            to: "/$threadId",
                                            params: { threadId: thread.id },
                                          });
                                        }}
                                        onContextMenu={(event) => {
                                          event.preventDefault();
                                          if (
                                            selectedThreadIds.size > 0 &&
                                            selectedThreadIds.has(thread.id)
                                          ) {
                                            void handleMultiSelectContextMenu({
                                              x: event.clientX,
                                              y: event.clientY,
                                            });
                                          } else {
                                            if (selectedThreadIds.size > 0) {
                                              clearSelection();
                                            }
                                            void handleThreadContextMenu(thread.id, {
                                              x: event.clientX,
                                              y: event.clientY,
                                            });
                                          }
                                        }}
                                      >
                                        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                          {prStatus && (
                                            <Tooltip>
                                              <TooltipTrigger
                                                render={
                                                  <button
                                                    type="button"
                                                    aria-label={prStatus.tooltip}
                                                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                                    onClick={(event) => {
                                                      openPrLink(event, prStatus.url);
                                                    }}
                                                  >
                                                    <GitPullRequestIcon className="size-3" />
                                                  </button>
                                                }
                                              />
                                              <TooltipPopup side="top">
                                                {prStatus.tooltip}
                                              </TooltipPopup>
                                            </Tooltip>
                                          )}
                                          {threadStatus ? (
                                            <ThreadStatusPillBadge
                                              pill={threadStatus}
                                              hideLabelBelowMd
                                            />
                                          ) : null}
                                          {renamingThreadId === thread.id ? (
                                            <InlineTitleEditor
                                              initialValue={thread.title}
                                              onCommit={(nextValue) => {
                                                void commitRename(
                                                  thread.id,
                                                  nextValue,
                                                  thread.title,
                                                );
                                              }}
                                              onCancel={cancelRename}
                                            />
                                          ) : (
                                            <Tooltip>
                                              <TooltipTrigger
                                                render={
                                                  <span className="min-w-0 flex-1 truncate text-xs">
                                                    {thread.title}
                                                  </span>
                                                }
                                              />
                                              <TooltipPopup
                                                side="top"
                                                className="max-w-80 whitespace-normal leading-tight"
                                              >
                                                {thread.title}
                                              </TooltipPopup>
                                            </Tooltip>
                                          )}
                                        </div>
                                        <ThreadRowTrailingMeta
                                          lastInteractionAt={thread.lastInteractionAt}
                                          terminalStatus={terminalStatus}
                                          isHighlighted={isHighlighted}
                                          archived
                                          action={{
                                            label: "Unarchive",
                                            ariaLabel: `Unarchive ${thread.title}`,
                                            onClick: () => {
                                              void setThreadArchived(thread.id, false);
                                            },
                                          }}
                                        />
                                      </SidebarMenuSubButton>
                                    </SidebarMenuSubItem>
                                  );
                                })}

                              {!archivedSectionCollapsed &&
                                hasHiddenArchivedItems &&
                                !archivedExpanded && (
                                  <SidebarMenuSubItem className="w-full">
                                    <SidebarMenuSubButton
                                      render={<button type="button" />}
                                      data-thread-selection-safe
                                      size="sm"
                                      className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                      onClick={() => {
                                        expandThreadListForProject(project.id, "archived");
                                      }}
                                    >
                                      <span>Show more</span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                )}
                              {!archivedSectionCollapsed &&
                                hasHiddenArchivedItems &&
                                archivedExpanded && (
                                  <SidebarMenuSubItem className="w-full">
                                    <SidebarMenuSubButton
                                      render={<button type="button" />}
                                      data-thread-selection-safe
                                      size="sm"
                                      className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                      onClick={() => {
                                        collapseThreadListForProject(project.id, "archived");
                                      }}
                                    >
                                      <span>Show less</span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                )}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                    </SortableProjectItem>
                  );
                })}
              </SortableContext>
            </SidebarMenu>
          </DndContext>

          {projects.length === 0 && !shouldShowProjectPathEntry && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      {workflowDialogProjectId ? (
        <WorkflowCreateDialog
          open
          projectId={workflowDialogProjectId}
          onOpenChange={(open) => {
            if (!open) {
              closeWorkflowCreateDialog();
            }
          }}
          onWorkflowCreated={handleWorkflowCreated}
        />
      ) : null}
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            {isOnSettings ? (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() =>
                  void navigate({
                    to: "/settings",
                    search: resolveSettingsNavigationSearch(settingsLocation),
                  })
                }
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-xs">Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </div>
  );
}
