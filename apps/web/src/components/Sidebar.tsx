import { ArrowLeftIcon, FolderPlusIcon, KeyboardIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useShortcutsDialogStore } from "../shortcutsDialogStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isArchivedWorkflow } from "@t3tools/shared/workflowArchive";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStartupReady } from "../lib/startupReady";
import { cn, newCommandId } from "../lib/utils";
import {
  getMostRecentProject,
  getMostRecentThreadForProject,
  isArchivedThread,
  isSnoozedThread,
} from "../lib/threadOrdering";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useStore } from "../store";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useWorkflowCreateDialogStore } from "../workflowCreateDialogStore";
import { useThreadStatusById } from "../hooks/useThreadStatusById";
import {
  bucketThreadsByAttention,
  selectStandaloneThreadsByActivity,
  selectVisibleWorkflowThreads,
} from "../lib/threadAttentionBuckets";
import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import { pillForStatus } from "../threadStatus";
import { toastManager } from "./ui/toast";
import { type Project, type Thread } from "../types";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { setWorkflowArchived } from "../archiveActions";
import {
  reconcileFrozenOrder,
  resolvePrimaryNewThreadProjectId,
  shouldClearThreadSelectionOnMouseDown,
  toggleWorkflowThreadListExpansion,
  threadBucketExpansionKey,
  type SidebarThreadBucket,
} from "./Sidebar.logic";
import { isWsInteractionBlocked, useWsConnectionState } from "../wsConnectionState";
import { StartupSidebarSkeleton } from "./StartupLoadingState";
import { resolveSettingsNavigationSearch } from "./settings/settingsCategories";
import { orderedPinnedThreadIds, replacePinnedThreads } from "../threadPinSnooze";
import { SidebarThreadSearchResults } from "./SidebarThreadSearch";
import { SidebarAddProjectForm, useAddProject } from "./sidebar/SidebarAddProjectForm";
import { SidebarArm64Warning, SidebarBrandHeader } from "./sidebar/SidebarBrandHeader";
import { SidebarAttentionSection } from "./sidebar/SidebarAttentionSection";
import { SIDEBAR_NAV_ROW_CLASS_NAME, SidebarNav } from "./sidebar/SidebarNav";
import { SidebarPrimaryActions } from "./sidebar/SidebarPrimaryActions";
import { SidebarProjectItem, type SidebarProjectActions } from "./sidebar/SidebarProjectItem";
import type { SidebarThreadRowIndicators } from "./sidebar/SidebarWorkflowItem";
import {
  type SidebarHoverFreezeSnapshot,
  type SidebarWorkflowId,
  type SidebarWorkflowType,
  type ThreadPr,
  buildProjectSidebarLists,
  prStatusIndicator,
  terminalStatusFromRunningIds,
  threadIdFromPinnedSortableId,
  workflowEntryKey,
} from "./sidebar/sidebarLists";
import { useDesktopUpdate } from "./sidebar/useDesktopUpdate";
import { useSidebarThreadActions } from "./sidebar/useSidebarThreadActions";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const planningWorkflows = useStore((store) => store.planningWorkflows);
  const codeReviewWorkflows = useStore((store) => store.codeReviewWorkflows);
  const investigationWorkflows = useStore((store) => store.investigationWorkflows);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const pinRevision = useStore((store) => store.pinRevision ?? 0);
  const startupReady = useStartupReady();
  const toggleProject = useStore((store) => store.toggleProject);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const projectDraftThreadIdByProjectId = useComposerDraftStore(
    (store) => store.projectDraftThreadIdByProjectId,
  );
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const navigate = useNavigate();
  const settingsLocation = useLocation({
    select: (location) => ({
      pathname: location.pathname,
      search: location.search,
    }),
  });
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const isOnUsage = useLocation({ select: (loc) => loc.pathname === "/usage" });
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const { settings: appSettings } = useAppSettings();
  const threadPreviewLimit = appSettings.sidebarThreadPreviewCount;
  const wsConnectionState = useWsConnectionState();
  const wsInteractionBlocked = isWsInteractionBlocked(wsConnectionState.phase);
  const setCommandPaletteOpen = useCommandPaletteStore((store) => store.setOpen);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = routeThreadId
    ? threads.find((thread) => thread.id === routeThreadId)
    : undefined;
  const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [collapsedArchivedSectionsByProject, setCollapsedArchivedSectionsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [collapsedSnoozedSectionsByProject, setCollapsedSnoozedSectionsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const openWorkflowCreateDialog = useWorkflowCreateDialogStore((state) => state.open);
  const lastCreatedWorkflowId = useWorkflowCreateDialogStore(
    (state) => state.lastCreatedWorkflowId,
  );
  const queueSummary = useNextTurnQueueStore((state) => state.summary);
  const [workflowExpandedById, setWorkflowExpandedById] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [sidebarHoverFreezeSnapshot, setSidebarHoverFreezeSnapshot] =
    useState<SidebarHoverFreezeSnapshot | null>(null);
  const archivedSectionsInitializedRef = useRef(false);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const sidebarHoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const firstProjectId = projects[0]?.id ?? null;
  const mostRecentProjectId = useMemo(
    () =>
      getMostRecentProject(
        projects,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
        investigationWorkflows,
      )?.id ?? null,
    [codeReviewWorkflows, investigationWorkflows, planningWorkflows, projects, threads],
  );
  const primaryProjectId = resolvePrimaryNewThreadProjectId({
    activeThreadProjectId: activeThread?.projectId,
    activeDraftProjectId: activeDraftThread?.projectId,
    mostRecentProjectId,
    firstProjectId,
  });
  const threadStatusById = useThreadStatusById(threads);
  const threadActions = useSidebarThreadActions({
    projects,
    threads,
    routeThreadId,
    activeThread,
    activeDraftThread,
    confirmThreadDelete: appSettings.confirmThreadDelete,
  });
  const { handleNewThread, deleteThreads } = threadActions;
  const desktopUpdate = useDesktopUpdate();

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
        autoRefresh: appSettings.gitStatusAutoRefreshIntervalSeconds > 0,
        staleTimeMs: 30_000,
        refetchIntervalMs: appSettings.gitStatusAutoRefreshIntervalSeconds * 1000,
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
  const indicatorsForThread = (thread: Thread): SidebarThreadRowIndicators => ({
    threadStatus: pillForStatus(threadStatusById.get(thread.id) ?? "none"),
    prStatus: prStatusIndicator(prByThreadId.get(thread.id) ?? null),
    terminalStatus: terminalStatusFromRunningIds(
      selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
    ),
  });
  const projectSidebarListsById = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          buildProjectSidebarLists({
            project,
            threads,
            planningWorkflows,
            codeReviewWorkflows,
            investigationWorkflows,
            draftThread: getDraftThreadByProjectId(project.id),
          }),
        ]),
      ),
    [
      codeReviewWorkflows,
      draftThreadsByThreadId,
      getDraftThreadByProjectId,
      investigationWorkflows,
      planningWorkflows,
      projectDraftThreadIdByProjectId,
      projects,
      threads,
    ],
  );
  const pausedQueueThreadIds = useMemo(
    () =>
      new Set(
        (queueSummary?.threads ?? [])
          .filter((entry) => entry.paused)
          .map((entry) => entry.threadId),
      ),
    [queueSummary],
  );
  const liveAttentionThreads = useMemo(() => {
    const input = { threads, planningWorkflows, codeReviewWorkflows, investigationWorkflows };
    return bucketThreadsByAttention(
      selectStandaloneThreadsByActivity(input),
      threadStatusById,
      pausedQueueThreadIds,
      selectVisibleWorkflowThreads(input),
    ).attention;
  }, [
    codeReviewWorkflows,
    investigationWorkflows,
    pausedQueueThreadIds,
    planningWorkflows,
    threadStatusById,
    threads,
  ]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const createSidebarHoverFreezeSnapshot = useCallback((): SidebarHoverFreezeSnapshot => {
    const workflowKeysByProjectId: Record<string, readonly string[]> = {};
    const workflowThreadIdsByWorkflowKey: Record<string, readonly ThreadId[]> = {};
    const activeThreadIdsByProjectId: Record<string, readonly ThreadId[]> = {};
    const archivedItemKeysByProjectId: Record<string, readonly string[]> = {};

    for (const project of projects) {
      const lists = projectSidebarListsById.get(project.id);
      if (!lists) continue;

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
      attentionThreadIds: liveAttentionThreads.map((thread) => thread.id),
    };
  }, [liveAttentionThreads, projectSidebarListsById, projects]);
  // Hover freezes the "Needs you" order so rows do not reshuffle under the
  // pointer; resolved threads still drop out and new ones append at the end.
  const attentionThreads = reconcileFrozenOrder({
    items: liveAttentionThreads,
    getKey: (thread) => thread.id,
    frozenOrder: sidebarHoverFreezeSnapshot?.attentionThreadIds,
  });

  const handleSidebarSearchResultOpened = useCallback(() => {
    setSidebarSearchQuery("");
  }, []);

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = getMostRecentThreadForProject(
        projectId,
        threads,
        planningWorkflows,
        codeReviewWorkflows,
        investigationWorkflows,
      );
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [codeReviewWorkflows, investigationWorkflows, navigate, planningWorkflows, threads],
  );
  const addProject = useAddProject({
    projects,
    onProjectAdded: handleNewThread,
    onExistingProject: focusMostRecentThreadForProject,
  });
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
  useEffect(() => {
    if (!lastCreatedWorkflowId) return;
    handleWorkflowCreated(lastCreatedWorkflowId);
    useWorkflowCreateDialogStore.getState().clearCreated(lastCreatedWorkflowId);
  }, [handleWorkflowCreated, lastCreatedWorkflowId]);
  const [workflowToArchive, setWorkflowToArchive] = useState<{
    workflowId: SidebarWorkflowId;
    workflowTitle: string;
    workflowType: SidebarWorkflowType;
  } | null>(null);
  const archiveCancelRef = useRef<HTMLButtonElement>(null);
  const archiveTriggerRef = useRef<HTMLElement | null>(null);
  const archiveWorkflow = useCallback(
    (workflowId: SidebarWorkflowId, workflowTitle: string, workflowType: SidebarWorkflowType) => {
      archiveTriggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setWorkflowToArchive({
        workflowId,
        workflowTitle,
        workflowType,
      });
    },
    [],
  );

  const unarchiveWorkflow = useCallback(
    async (workflowId: SidebarWorkflowId, workflowType: SidebarWorkflowType) => {
      await setWorkflowArchived({
        workflowId,
        workflowType,
        archived: false,
      });
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
        const result = await deleteThreads(projectThreads.map((thread) => thread.id));
        if (result.failures.length > 0) throw result.failures[0]!.error;

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
    [clearProjectDraftThreadId, deleteThreads],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "icon", label: "Change project icon..." },
          { id: "change-path", label: "Change project path..." },
          { id: "rename", label: "Rename project" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;
      if (clicked === "icon") {
        await navigate({
          to: "/settings",
          search: { category: "projects", item: "projects.icon", projectId },
        });
        return;
      }
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
    [changeProjectWorkspaceRoot, navigate, projects, removeProjectWithThreads, threads],
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

  const handlePinnedThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeThreadId = threadIdFromPinnedSortableId(event.active.id);
      const overThreadId = event.over ? threadIdFromPinnedSortableId(event.over.id) : null;
      if (activeThreadId === null || overThreadId === null || activeThreadId === overThreadId) {
        return;
      }
      const pinnedThreadIds = orderedPinnedThreadIds(threads);
      const fromIndex = pinnedThreadIds.indexOf(activeThreadId);
      const toIndex = pinnedThreadIds.indexOf(overThreadId);
      if (fromIndex < 0 || toIndex < 0) return;
      void replacePinnedThreads({
        anchorThreadId: activeThreadId,
        pinnedThreadIds: arrayMove(pinnedThreadIds, fromIndex, toIndex),
        expectedRevision: pinRevision,
      }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to reorder pinned threads",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [pinRevision, threads],
  );

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
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, toggleProject],
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

      if (event.key === "Escape" && useThreadSelectionStore.getState().hasSelection()) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadId
            ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
            : false,
        },
      });
      if (!command) return;

      const projectId = resolvePrimaryNewThreadProjectId({
        activeThreadProjectId: activeThread?.projectId,
        activeDraftProjectId: activeDraftThread?.projectId,
        mostRecentProjectId,
        firstProjectId,
      });

      if (command === "workflow.new") {
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        openWorkflowCreateDialog(projectId);
        return;
      }

      if (command === "prHub.open") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({ to: "/pull-requests" });
        return;
      }

      if (command === "chat.newLocal") {
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        });
        return;
      }

      if (command !== "chat.new") return;
      if (!projectId) return;
      event.preventDefault();
      event.stopPropagation();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
      });
    };
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
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
    activeDraftThread,
    activeThread,
    clearSelection,
    firstProjectId,
    handleNewThread,
    keybindings,
    mostRecentProjectId,
    navigate,
    openWorkflowCreateDialog,
    routeThreadId,
    terminalStateByThreadId,
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

  const newThreadShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );
  const workflowShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "workflow.new"),
    [keybindings],
  );
  const commandPaletteShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "commandPalette.toggle"),
    [keybindings],
  );
  const shortcutsShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "help.shortcuts"),
    [keybindings],
  );
  const pullRequestsShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "prHub.open"),
    [keybindings],
  );
  const handleOpenCommandPalette = useCallback(() => {
    setCommandPaletteOpen(true);
  }, [setCommandPaletteOpen]);

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

  const toggleSnoozedSectionForProject = useCallback((projectId: ProjectId) => {
    setCollapsedSnoozedSectionsByProject((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
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
        ...investigationWorkflows
          .filter((workflow) => isArchivedWorkflow(workflow))
          .map((workflow) => workflow.projectId),
      ]),
    );
    setCollapsedSnoozedSectionsByProject(
      new Set(
        threads.filter((thread) => isSnoozedThread(thread)).map((thread) => thread.projectId),
      ),
    );
  }, [codeReviewWorkflows, investigationWorkflows, planningWorkflows, threads, threadsHydrated]);

  const projectActions: SidebarProjectActions = {
    onTitlePointerDownCapture: handleProjectTitlePointerDownCapture,
    onTitleClick: handleProjectTitleClick,
    onTitleKeyDown: handleProjectTitleKeyDown,
    onContextMenu: (projectId, position) => {
      void handleProjectContextMenu(projectId, position);
    },
    onCommitRename: (projectId, value, originalTitle) => {
      void commitProjectRename(projectId, value, originalTitle);
    },
    onCancelRename: cancelProjectRename,
    onCreateWorkflow: openWorkflowCreateDialog,
    onToggleWorkflowCollapsed: toggleWorkflowCollapsed,
    onArchiveWorkflow: (workflowId, title, type) => {
      void archiveWorkflow(workflowId, title, type);
    },
    onUnarchiveWorkflow: (workflowId, type) => {
      void unarchiveWorkflow(workflowId, type);
    },
    onExpandThreadList: expandThreadListForProject,
    onCollapseThreadList: collapseThreadListForProject,
    onToggleArchivedSection: toggleArchivedSectionForProject,
    onToggleSnoozedSection: toggleSnoozedSectionForProject,
    onPinnedThreadDragEnd: handlePinnedThreadDragEnd,
  };

  return (
    <div ref={sidebarHoverAnchorRef} className="contents">
      <SidebarBrandHeader update={desktopUpdate} />
      <SidebarPrimaryActions
        projectId={primaryProjectId}
        newThreadShortcutLabel={newThreadShortcutLabel}
        workflowShortcutLabel={workflowShortcutLabel}
        onNewThread={threadActions.createThreadInProject}
        onNewWorkflow={openWorkflowCreateDialog}
        onAddProject={addProject.handleStartAddProject}
      />

      <SidebarContent className="gap-0">
        <SidebarNav
          searchQuery={sidebarSearchQuery}
          onSearchQueryChange={setSidebarSearchQuery}
          onOpenCommandPalette={handleOpenCommandPalette}
          commandPaletteShortcutLabel={commandPaletteShortcutLabel}
          pullRequestsShortcutLabel={pullRequestsShortcutLabel}
        />
        <SidebarArm64Warning update={desktopUpdate} />
        {sidebarSearchQuery.trim().length > 0 ? (
          <SidebarThreadSearchResults
            query={sidebarSearchQuery}
            projects={projects}
            threads={threads}
            {...(routeThreadId ? { activeThreadId: routeThreadId } : {})}
            onResultOpened={handleSidebarSearchResultOpened}
          />
        ) : null}
        <div className={cn("px-2", sidebarSearchQuery.trim().length > 0 && "hidden")}>
          <SidebarAttentionSection
            threads={attentionThreads}
            projectsById={projectsById}
            routeThreadId={routeThreadId}
            indicatorsForThread={indicatorsForThread}
            actions={threadActions}
          />
        </div>
        <SidebarGroup
          className={cn("px-2 pt-0 pb-2", sidebarSearchQuery.trim().length > 0 && "hidden")}
        >
          <div className="flex h-7 items-center justify-between px-2">
            <span className="text-2xs font-medium text-muted-foreground">Projects</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    aria-pressed={addProject.showPathEntry}
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={addProject.handleStartAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>

          {addProject.showPathEntry && <SidebarAddProjectForm controller={addProject} />}

          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu className="gap-px">
              <SortableContext
                items={projects.map((project) => project.id)}
                strategy={verticalListSortingStrategy}
              >
                {projects.map((project) => {
                  const sidebarLists = projectSidebarListsById.get(project.id);
                  if (!sidebarLists) return null;
                  return (
                    <SidebarProjectItem
                      key={project.id}
                      project={project}
                      sidebarLists={sidebarLists}
                      freezeSnapshot={sidebarHoverFreezeSnapshot}
                      threadPreviewLimit={threadPreviewLimit}
                      activeExpanded={expandedThreadListsByProject.has(
                        threadBucketExpansionKey(project.id, "active"),
                      )}
                      archivedExpanded={expandedThreadListsByProject.has(
                        threadBucketExpansionKey(project.id, "archived"),
                      )}
                      archivedSectionCollapsed={collapsedArchivedSectionsByProject.has(project.id)}
                      snoozedSectionCollapsed={collapsedSnoozedSectionsByProject.has(project.id)}
                      draftThreadsByThreadId={draftThreadsByThreadId}
                      persistedThreadIds={persistedThreadIds}
                      routeThreadId={routeThreadId}
                      pathname={pathname}
                      isRenamingProject={renamingProjectId === project.id}
                      expandWorkflowThreadsByDefault={appSettings.expandWorkflowThreadsByDefault}
                      workflowExpandedById={workflowExpandedById}
                      newThreadShortcutLabel={newThreadShortcutLabel}
                      workflowShortcutLabel={workflowShortcutLabel}
                      dndSensors={projectDnDSensors}
                      collisionDetection={projectCollisionDetection}
                      indicatorsForThread={indicatorsForThread}
                      threadActions={threadActions}
                      projectActions={projectActions}
                    />
                  );
                })}
              </SortableContext>
            </SidebarMenu>
          </DndContext>

          {!startupReady && projects.length === 0 && !addProject.showPathEntry ? (
            <StartupSidebarSkeleton />
          ) : startupReady && projects.length === 0 && !addProject.showPathEntry ? (
            <div className="mx-1 mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-3 py-5 text-center">
              <p className="text-ui text-muted-foreground">No projects yet</p>
              <Button size="sm" variant="outline" onClick={addProject.handleStartAddProject}>
                <PlusIcon className="size-4" />
                Add a project
              </Button>
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <AlertDialog
        open={workflowToArchive !== null}
        onOpenChange={(open) => {
          if (!open) setWorkflowToArchive(null);
        }}
      >
        <AlertDialogPopup
          className="sm:max-w-[440px]"
          initialFocus={archiveCancelRef}
          finalFocus={archiveTriggerRef}
        >
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle>Archive workflow?</AlertDialogTitle>
            <p className="mt-1 text-sm font-medium wrap-anywhere">
              {workflowToArchive?.workflowTitle || "Untitled workflow"}
            </p>
            <AlertDialogDescription>
              Move this workflow to Archived. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button ref={archiveCancelRef} variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              onClick={() => {
                if (!workflowToArchive) return;
                setWorkflowToArchive(null);
                void setWorkflowArchived({
                  ...workflowToArchive,
                  archived: true,
                  confirm: false,
                });
              }}
            >
              Archive workflow
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <div className="pb-safe-add">
        <SidebarFooter className="p-2">
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-1">
              {isOnSettings || isOnUsage ? (
                <SidebarMenuButton
                  className={SIDEBAR_NAV_ROW_CLASS_NAME}
                  onClick={() => window.history.back()}
                >
                  <ArrowLeftIcon className="size-4" />
                  <span>Back</span>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  className={SIDEBAR_NAV_ROW_CLASS_NAME}
                  onClick={() =>
                    void navigate({
                      to: "/settings",
                      search: resolveSettingsNavigationSearch(settingsLocation),
                    })
                  }
                >
                  <SettingsIcon className="size-4" />
                  <span>Settings</span>
                </SidebarMenuButton>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Keyboard shortcuts"
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={() => useShortcutsDialogStore.getState().setOpen(true)}
                    />
                  }
                >
                  <KeyboardIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  Keyboard shortcuts
                  {shortcutsShortcutLabel ? (
                    <span className="ml-1.5 text-muted-foreground">{shortcutsShortcutLabel}</span>
                  ) : null}
                </TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </div>
    </div>
  );
}
