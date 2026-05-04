import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import { useAppSettings } from "../appSettings";
import ChatView from "../components/ChatView";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { Button } from "../components/ui/button";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  clearDiffSearchParams,
  clearFileViewSearchParams,
  type DiffRouteSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useThreadDetail } from "../lib/orchestrationReactQuery";
import { useStore } from "../store";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const FileViewPanel = lazy(() => import("../components/FileViewPanel"));
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

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

const LazyFileViewPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <FileViewPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  open: boolean;
  onClose: () => void;
  onOpenDiff: () => void;
  renderDiffContent: boolean;
  fileViewOpen: boolean;
  hasOpenedFileView: boolean;
}) => {
  const { open, onClose, onOpenDiff, renderDiffContent, fileViewOpen, hasOpenedFileView } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onClose();
    },
    [onClose, onOpenDiff],
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
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <div
          className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ display: fileViewOpen ? "none" : "flex" }}
        >
          {renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null}
        </div>
        <div
          className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ display: fileViewOpen ? "flex" : "none" }}
        >
          {hasOpenedFileView ? <LazyFileViewPanel mode="sidebar" /> : null}
        </div>
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
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const { settings } = useAppSettings();
  const thread = useStore((store) => store.threads.find((entry) => entry.id === threadId));
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const threadDetailQuery = useThreadDetail(thread ? threadId : null, {
    includeCommandExecutionHistory: settings.showAgentCommandTranscripts,
  });
  const diffOpen = search.diff === "1";
  const fileViewOpen = !!search.fileViewPath;
  const panelOpen = diffOpen || fileViewOpen;
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // TanStack Router keeps active route components mounted across param-only navigations
  // unless remountDeps are configured, so this stays warm across thread switches.
  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);
  const [hasOpenedFileView, setHasOpenedFileView] = useState(fileViewOpen);
  const closeDiffPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => clearDiffSearchParams(previous),
    });
  }, [navigate, threadId]);
  const closeFileViewPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => clearFileViewSearchParams(previous),
    });
  }, [navigate, threadId]);
  const closeActivePanel = fileViewOpen ? closeFileViewPanel : closeDiffPanel;
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = clearDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (diffOpen) {
      setHasOpenedDiff(true);
    }
  }, [diffOpen]);

  useEffect(() => {
    if (fileViewOpen) {
      setHasOpenedFileView(true);
    }
  }, [fileViewOpen]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

  if (!threadsHydrated || !routeThreadExists) {
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
    const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
    if (shouldUseDiffSheet) {
      return (
        <>
          <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
            {detailView}
          </SidebarInset>
          <RightPanelSheet open={panelOpen} onClose={closeActivePanel}>
            <div
              className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
              style={{ display: fileViewOpen ? "none" : "flex" }}
            >
              {shouldRenderDiffContent ? <DiffLoadingFallback mode="sheet" /> : null}
            </div>
            <div
              className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
              style={{ display: fileViewOpen ? "flex" : "none" }}
            >
              {hasOpenedFileView ? <DiffLoadingFallback mode="sheet" /> : null}
            </div>
          </RightPanelSheet>
        </>
      );
    }
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          {detailView}
        </SidebarInset>
        <DiffPanelInlineSidebar
          open={panelOpen}
          onClose={closeActivePanel}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderDiffContent}
          fileViewOpen={fileViewOpen}
          hasOpenedFileView={hasOpenedFileView}
        />
      </>
    );
  }
  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh  min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView key={threadId} threadId={threadId} />
        </SidebarInset>
        <DiffPanelInlineSidebar
          open={panelOpen}
          onClose={closeActivePanel}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderDiffContent}
          fileViewOpen={fileViewOpen}
          hasOpenedFileView={hasOpenedFileView}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView key={threadId} threadId={threadId} />
      </SidebarInset>
      <RightPanelSheet open={panelOpen} onClose={closeActivePanel}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ display: fileViewOpen ? "none" : "flex" }}
        >
          {shouldRenderDiffContent ? <LazyDiffPanel mode="sheet" /> : null}
        </div>
        <div
          className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ display: fileViewOpen ? "flex" : "none" }}
        >
          {hasOpenedFileView ? <LazyFileViewPanel mode="sheet" /> : null}
        </div>
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
        "fileViewPath",
        "fileLine",
        "fileEndLine",
        "fileColumn",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
