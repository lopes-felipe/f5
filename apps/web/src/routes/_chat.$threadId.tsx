import { ThreadId, type OrchestrationThreadActivity, type TaskItem } from "@t3tools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { useAppSettings } from "../appSettings";
import ChatView from "../components/ChatView";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import PlanSidebar from "../components/PlanSidebar";
import { RightPanelHost } from "../components/RightPanelHost";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { StartupThreadRouteSkeleton } from "../components/StartupLoadingState";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  clearFileViewSearchParams,
  clearTurnDiffSearchParams,
  type DiffRouteSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useThreadDetail } from "../lib/orchestrationReactQuery";
import { useStartupReady } from "../lib/startupReady";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  clearSearchParamsForSurface,
  openFileRightPanelSurface,
  setSearchParamsForSurface,
} from "../rightPanelNavigation";
import {
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  deriveActivePlanState,
  findLatestProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { useStore } from "../store";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const FileBrowserPanel = lazy(() => import("../components/FileBrowserPanel"));
const FileViewPanel = lazy(() => import("../components/FileViewPanel"));
const PreviewPanel = lazy(() => import("../components/PreviewPanel"));
const RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_sidebar_width";
const RIGHT_PANEL_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const EMPTY_TASKS: ReadonlyArray<TaskItem> = [];
type RightPanelRenderMode = Extract<DiffPanelMode, "sheet" | "sidebar">;
type FileRightPanelSurface = Extract<RightPanelSurface, { kind: "file" }>;

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const LazyFileViewPanel = (props: {
  mode: DiffPanelMode;
  surface: FileRightPanelSurface;
  onClose: () => void;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <FileViewPanel mode={props.mode} surface={props.surface} onClose={props.onClose} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const LazyFileBrowserPanel = (props: {
  cwd: string | null;
  projectName: string;
  entryLimit: number;
  onOpenFile: (relativePath: string) => void;
}) => {
  return (
    <Suspense fallback={<DiffPanelLoadingState label="Loading workspace files..." />}>
      <FileBrowserPanel
        cwd={props.cwd}
        projectName={props.projectName}
        entryLimit={props.entryLimit}
        onOpenFile={props.onOpenFile}
      />
    </Suspense>
  );
};

const LazyPreviewPanel = (props: { threadId: ThreadId; onClose: () => void }) => {
  return (
    <Suspense fallback={<DiffPanelLoadingState label="Loading preview..." />}>
      <PreviewPanel threadId={props.threadId} onClose={props.onClose} />
    </Suspense>
  );
};

function buildDeepLinkKey(threadId: ThreadId, search: DiffRouteSearch): string {
  return [
    threadId,
    search.diff ?? "",
    search.diffTurnId ?? "",
    search.diffFileChangeId ?? "",
    search.diffFilePath ?? "",
    search.fileViewPath ?? "",
    search.fileLine ?? "",
    search.fileEndLine ?? "",
    search.fileColumn ?? "",
  ].join("\u0000");
}

function getFallbackSurfaceAfterClose(
  surfaces: ReadonlyArray<RightPanelSurface>,
  activeSurfaceId: string | null,
  closedSurfaceId: string,
): RightPanelSurface | null {
  const index = surfaces.findIndex((surface) => surface.id === closedSurfaceId);
  if (index < 0) {
    return null;
  }
  const remaining = surfaces.filter((surface) => surface.id !== closedSurfaceId);
  if (activeSurfaceId !== closedSurfaceId) {
    return remaining.find((surface) => surface.id === activeSurfaceId) ?? null;
  }
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

const RightPanelInlineSidebar = (props: {
  open: boolean;
  onClose: () => void;
  onOpenDefaultSurface: () => void;
  children: ReactNode;
}) => {
  const { open, onClose, onOpenDefaultSurface } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDefaultSurface();
        return;
      }
      onClose();
    },
    [onClose, onOpenDefaultSurface],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": RIGHT_PANEL_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {props.children}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function formatThreadDetailError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Failed to load thread details.";
}

function ThreadDetailErrorView(props: {
  title: string;
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{props.title}</p>
            <p className="text-xs text-muted-foreground">Unable to load thread details.</p>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
        <div className="mx-auto w-full max-w-3xl">
          <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-sm backdrop-blur-sm">
            <p className="text-sm font-medium text-foreground">Thread details failed to load</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {formatThreadDetailError(props.error)}
            </p>
            <div className="mt-4">
              <Button onClick={props.onRetry} disabled={props.retrying}>
                {props.retrying ? "Retrying..." : "Retry"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatThreadRouteView() {
  const startupReady = useStartupReady();
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const { settings } = useAppSettings();
  const thread = useStore((store) => store.threads.find((entry) => entry.id === threadId));
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const activeProject = useStore((store) =>
    thread?.projectId ? store.projects.find((project) => project.id === thread.projectId) : null,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const threadDetailQuery = useThreadDetail(thread ? threadId : null, {
    includeCommandExecutionHistory: settings.showAgentCommandTranscripts,
  });
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const rightPanelState = useRightPanelStore((store) =>
    selectThreadRightPanelState(store.byThreadId, threadId),
  );
  const consumedDeepLinkKeyRef = useRef<string | null>(null);
  const threadActivities = thread?.activities ?? EMPTY_ACTIVITIES;
  const threadTasks = thread?.tasks ?? EMPTY_TASKS;
  const latestTurn = thread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(latestTurn, thread?.session ?? null);
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(thread?.proposedPlans ?? [], latestTurn?.turnId ?? null);
  }, [latestTurn?.turnId, latestTurnSettled, thread?.proposedPlans]);
  const activePlan = useMemo(
    () =>
      deriveActivePlanState(threadActivities, latestTurn?.turnId ?? undefined, {
        tasks: threadTasks,
        turnId: thread?.tasksTurnId ?? null,
        updatedAt: thread?.tasksUpdatedAt ?? null,
      }),
    [
      latestTurn?.turnId,
      thread?.tasksTurnId,
      thread?.tasksUpdatedAt,
      threadActivities,
      threadTasks,
    ],
  );
  const markdownCwd = thread?.worktreePath ?? activeProject?.cwd ?? undefined;
  const workspaceRoot = activeProject?.cwd ?? undefined;
  const workspaceBrowserRoot = thread?.worktreePath ?? activeProject?.cwd ?? null;
  const workspaceBrowserName = activeProject?.name ?? "Workspace";
  const previewAvailable = typeof window !== "undefined" && Boolean(window.desktopBridge?.preview);
  const { copyToClipboard } = useCopyToClipboard<{ relativePath: string }>({
    onCopy: ({ relativePath }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: relativePath,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy path",
        description: error.message,
      });
    },
  });

  useEffect(() => {
    const deepLinkKey = buildDeepLinkKey(threadId, search);
    if (consumedDeepLinkKeyRef.current === deepLinkKey) {
      return;
    }
    consumedDeepLinkKeyRef.current = deepLinkKey;
    const rightPanelStore = useRightPanelStore.getState();
    const currentState = selectThreadRightPanelState(rightPanelStore.byThreadId, threadId);
    const activeSurface =
      currentState.surfaces.find((surface) => surface.id === currentState.activeSurfaceId) ?? null;

    if (search.diff === "1") {
      rightPanelStore.open(threadId, "diff");
    } else if (currentState.surfaces.some((surface) => surface.kind === "diff")) {
      rightPanelStore.closeSurface(threadId, "diff");
    }
    if (search.fileViewPath) {
      rightPanelStore.openFile(threadId, {
        relativePath: search.fileViewPath,
        line: search.fileLine,
        endLine: search.fileEndLine,
        column: search.fileColumn,
      });
    } else if (activeSurface?.kind === "file") {
      rightPanelStore.closeSurface(threadId, activeSurface.id);
    }
  }, [
    search.diff,
    search.diffFileChangeId,
    search.diffFilePath,
    search.diffTurnId,
    search.fileColumn,
    search.fileEndLine,
    search.fileLine,
    search.fileViewPath,
    threadId,
  ]);

  useEffect(() => {
    if (!startupReady) {
      return;
    }

    if (!routeThreadExists) {
      useRightPanelStore.getState().removeThread(threadId);
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, routeThreadExists, startupReady, threadId]);

  const clearSearchParamsForSurfaces = useCallback(
    (surfaces: ReadonlyArray<RightPanelSurface>) => {
      if (surfaces.length === 0) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => {
          let next: Record<string, unknown> = previous;
          for (const surface of surfaces) {
            next = clearSearchParamsForSurface(next, surface);
          }
          return next;
        },
      });
    },
    [navigate, threadId],
  );

  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      const fallbackSurface = getFallbackSurfaceAfterClose(
        rightPanelState.surfaces,
        rightPanelState.activeSurfaceId,
        surface.id,
      );
      useRightPanelStore.getState().closeSurface(threadId, surface.id);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => {
          const withoutClosedSurface = clearSearchParamsForSurface(previous, surface);
          return fallbackSurface
            ? setSearchParamsForSurface(withoutClosedSurface, fallbackSurface)
            : withoutClosedSurface;
        },
      });
    },
    [navigate, rightPanelState.activeSurfaceId, rightPanelState.surfaces, threadId],
  );

  const closeActivePanel = useCallback(() => {
    const activeSurface =
      rightPanelState.surfaces.find((surface) => surface.id === rightPanelState.activeSurfaceId) ??
      null;
    if (!activeSurface) {
      useRightPanelStore.getState().close(threadId);
      return;
    }
    closeRightPanelSurface(activeSurface);
  }, [closeRightPanelSurface, rightPanelState.activeSurfaceId, rightPanelState.surfaces, threadId]);

  const openDiff = useCallback(() => {
    useRightPanelStore.getState().open(threadId, "diff");
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => ({
        ...clearFileViewSearchParams(clearTurnDiffSearchParams(previous)),
        diff: "1",
      }),
    });
  }, [navigate, threadId]);

  const openPlan = useCallback(() => {
    useRightPanelStore.getState().open(threadId, "plan");
  }, [threadId]);

  const openFiles = useCallback(() => {
    useRightPanelStore.getState().open(threadId, "files");
  }, [threadId]);

  const openPreview = useCallback(() => {
    useRightPanelStore.getState().open(threadId, "preview");
  }, [threadId]);

  const openWorkspaceFile = useCallback(
    (relativePath: string) => {
      const surface = openFileRightPanelSurface(threadId, { relativePath });
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => setSearchParamsForSurface(previous, surface),
      });
    },
    [navigate, threadId],
  );

  const closeOtherSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      const removed = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      useRightPanelStore.getState().closeOtherSurfaces(threadId, surface.id);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => {
          let next: Record<string, unknown> = previous;
          for (const removedSurface of removed) {
            next = clearSearchParamsForSurface(next, removedSurface);
          }
          return setSearchParamsForSurface(next, surface);
        },
      });
    },
    [navigate, rightPanelState.surfaces, threadId],
  );

  const closeSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      const index = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (index < 0) {
        return;
      }
      const removed = rightPanelState.surfaces.slice(index + 1);
      const remaining = rightPanelState.surfaces.slice(0, index + 1);
      const nextActiveSurface =
        remaining.find((entry) => entry.id === rightPanelState.activeSurfaceId) ?? surface;
      useRightPanelStore.getState().closeSurfacesToRight(threadId, surface.id);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => {
          let next: Record<string, unknown> = previous;
          for (const removedSurface of removed) {
            next = clearSearchParamsForSurface(next, removedSurface);
          }
          return setSearchParamsForSurface(next, nextActiveSurface);
        },
      });
    },
    [navigate, rightPanelState.activeSurfaceId, rightPanelState.surfaces, threadId],
  );

  const closeAllSurfaces = useCallback(() => {
    const removed = rightPanelState.surfaces;
    useRightPanelStore.getState().closeAllSurfaces(threadId);
    clearSearchParamsForSurfaces(removed);
  }, [clearSearchParamsForSurfaces, rightPanelState.surfaces, threadId]);

  const closeRightPanelSheet = useCallback(() => {
    useRightPanelStore.getState().closeAllSurfaces(threadId);
    clearSearchParamsForSurfaces(rightPanelState.surfaces);
  }, [clearSearchParamsForSurfaces, rightPanelState.surfaces, threadId]);

  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      useRightPanelStore.getState().activateSurface(threadId, surface.id);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => setSearchParamsForSurface(previous, surface),
      });
    },
    [navigate, threadId],
  );

  const renderRightPanelSurface = useCallback(
    (mode: RightPanelRenderMode, loadingOnly = false) =>
      (surface: RightPanelSurface): ReactNode => {
        switch (surface.kind) {
          case "diff":
            return loadingOnly ? (
              <DiffLoadingFallback mode={mode} />
            ) : (
              <LazyDiffPanel mode={mode} />
            );
          case "file":
            return loadingOnly ? (
              <DiffLoadingFallback mode={mode} />
            ) : (
              <LazyFileViewPanel
                mode={mode}
                surface={surface}
                onClose={() => closeRightPanelSurface(surface)}
              />
            );
          case "plan":
            return (
              <PlanSidebar
                activePlan={activePlan}
                activeProposedPlan={activeProposedPlan}
                markdownCwd={markdownCwd}
                workspaceRoot={workspaceRoot}
                timestampFormat={settings.timestampFormat}
                mode="sheet"
                onClose={() => closeRightPanelSurface(surface)}
              />
            );
          case "files":
            return (
              <LazyFileBrowserPanel
                cwd={workspaceBrowserRoot}
                projectName={workspaceBrowserName}
                entryLimit={settings.workspaceFileTreeEntryLimit}
                onOpenFile={openWorkspaceFile}
              />
            );
          case "preview":
            return loadingOnly ? (
              <DiffPanelLoadingState label="Loading preview..." />
            ) : (
              <LazyPreviewPanel
                threadId={threadId}
                onClose={() => closeRightPanelSurface(surface)}
              />
            );
        }
      },
    [
      activePlan,
      activeProposedPlan,
      closeRightPanelSurface,
      markdownCwd,
      openWorkspaceFile,
      settings.timestampFormat,
      threadId,
      workspaceBrowserName,
      workspaceBrowserRoot,
      workspaceRoot,
    ],
  );

  const renderRightPanelHost = useCallback(
    (mode: RightPanelRenderMode, loadingOnly = false) => (
      <RightPanelHost
        mode={mode}
        state={rightPanelState}
        renderSurface={renderRightPanelSurface(mode, loadingOnly)}
        onActivate={activateRightPanelSurface}
        onCloseSurface={closeRightPanelSurface}
        onCloseOtherSurfaces={closeOtherSurfaces}
        onCloseSurfacesToRight={closeSurfacesToRight}
        onCloseAllSurfaces={closeAllSurfaces}
        onCopyFilePath={(relativePath) => copyToClipboard(relativePath, { relativePath })}
        onAddPreview={openPreview}
        onAddFiles={openFiles}
        onAddDiff={openDiff}
        onAddPlan={openPlan}
        previewAvailable={previewAvailable}
        filesAvailable={routeThreadExists && !!workspaceBrowserRoot}
        diffAvailable={routeThreadExists}
        planAvailable={routeThreadExists}
      />
    ),
    [
      closeAllSurfaces,
      closeOtherSurfaces,
      closeRightPanelSurface,
      closeSurfacesToRight,
      copyToClipboard,
      activateRightPanelSurface,
      openDiff,
      openFiles,
      openPlan,
      openPreview,
      previewAvailable,
      renderRightPanelSurface,
      rightPanelState,
      routeThreadExists,
      workspaceBrowserRoot,
    ],
  );

  if (!startupReady) {
    return <StartupThreadRouteSkeleton />;
  }

  if (!routeThreadExists) {
    return null;
  }

  if (
    thread &&
    !thread.detailsLoaded &&
    threadDetailQuery.isError &&
    !threadDetailQuery.isFetching
  ) {
    const detailView = (
      <ThreadDetailErrorView
        title={thread.title}
        error={threadDetailQuery.error}
        onRetry={() => {
          void threadDetailQuery.refetch();
        }}
        retrying={threadDetailQuery.isFetching}
      />
    );
    if (shouldUseRightPanelSheet) {
      return (
        <>
          <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
            {detailView}
          </SidebarInset>
          <RightPanelSheet open={rightPanelState.isOpen} onClose={closeRightPanelSheet}>
            {renderRightPanelHost("sheet", true)}
          </RightPanelSheet>
        </>
      );
    }
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          {detailView}
        </SidebarInset>
        <RightPanelInlineSidebar
          open={rightPanelState.isOpen}
          onClose={closeActivePanel}
          onOpenDefaultSurface={openDiff}
        >
          {renderRightPanelHost("sidebar", true)}
        </RightPanelInlineSidebar>
      </>
    );
  }

  if (!shouldUseRightPanelSheet) {
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView key={threadId} threadId={threadId} />
        </SidebarInset>
        <RightPanelInlineSidebar
          open={rightPanelState.isOpen}
          onClose={closeActivePanel}
          onOpenDefaultSurface={openDiff}
        >
          {renderRightPanelHost("sidebar")}
        </RightPanelInlineSidebar>
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView key={threadId} threadId={threadId} />
      </SidebarInset>
      <RightPanelSheet open={rightPanelState.isOpen} onClose={closeRightPanelSheet}>
        {renderRightPanelHost("sheet")}
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [
      retainSearchParams<DiffRouteSearch>([
        "diff",
        "diffTurnId",
        "diffFileChangeId",
        "diffFilePath",
        "fileViewPath",
        "fileLine",
        "fileEndLine",
        "fileColumn",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
