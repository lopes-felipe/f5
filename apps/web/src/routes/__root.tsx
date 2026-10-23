import { createOrchestrationSyncController } from "../orchestration/syncController";
export {
  applyProviderAdvisoriesToServerConfig,
  pruneDraftThreadsForCurrentProjects,
  reconcileDraftThreadsAfterStartupSnapshot,
} from "../orchestration/syncController";

import { usePreviewArtifactRetentionSync } from "../hooks/usePreviewArtifactRetentionSync";
import { useMigrateClientSettings } from "../hooks/useMigrateClientSettings";

import { type ProviderInstanceId } from "@t3tools/contracts";
import {
  Outlet,
  Link,
  lazyRouteComponent,
  createRootRouteWithContext,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import {
  SlowRpcWarningToastCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";

import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT } from "../composerDraftStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";

import { type AppSettings, updateAppSettings, useAppSettingsSelector } from "../appSettings";
import { HtmlPreviewHost } from "../components/HtmlPreviewHost";

import { useAppearanceSettingsSync } from "../hooks/useAppearanceSettings";
import { useTheme } from "../hooks/useTheme";
import { useThemePaletteSync } from "../hooks/useThemePalette";
import { type ThreadWarmProfile } from "../lib/threadPreload";
import { startThreadDetailRetention } from "../lib/threadDetailRetention";

import { startWorkspaceWatchSync } from "../lib/workspaceWatch";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: lazyRouteComponent(() => import("../components/RootRouteErrorView")),
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  useMigrateClientSettings();
  useAppearanceSettingsSync();
  usePreviewArtifactRetentionSync();
  const { resolvedTheme } = useTheme();
  useThemePaletteSync(resolvedTheme);

  useEffect(() => {
    const showPersistenceError = () => {
      toastManager.add({
        type: "error",
        title: "Drafts could not be saved",
        description: "Free some browser storage before closing F5 to avoid losing this draft.",
      });
    };
    window.addEventListener(COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT, showPersistenceError);
    return () =>
      window.removeEventListener(COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT, showPersistenceError);
  }, []);

  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <DesktopProjectBootstrap />
        <HtmlPreviewHost />
        <SlowRpcWarningToastCoordinator />
        <WebSocketConnectionSurface>
          <Outlet />
        </WebSocketConnectionSurface>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link does not point to a page in {APP_DISPLAY_NAME}.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

// The root reads few settings; selecting them keeps other settings writes from re-rendering it.
function selectRootSettings(settings: AppSettings) {
  return {
    diffColorPalette: settings.diffColorPalette,
    dismissedProviderUpdateAdvisories: settings.dismissedProviderUpdateAdvisories,
    showFileChangeDiffsInline: settings.showFileChangeDiffsInline,
  };
}

function EventRouter() {
  const applyDomainEvent = useStore((store) => store.applyDomainEvent);
  const applyDomainEventBatch = useStore((store) => store.applyDomainEventBatch);
  const invalidateThreadDetails = useStore((store) => store.invalidateThreadDetails);
  const syncStartupSnapshot = useStore((store) => store.syncStartupSnapshot);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const applyTerminalEvent = useTerminalStateStore((store) => store.applyTerminalEvent);
  const markRecoveryComplete = useRecoveryStateStore((store) => store.markRecoveryComplete);
  const syncThreadTailDetails = useStore((store) => store.syncThreadTailDetails);
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const navigate = useNavigate();
  const settings = useAppSettingsSelector(selectRootSettings);
  const updateSettings = updateAppSettings;
  useEffect(() => startThreadDetailRetention(queryClient), [queryClient]);
  useEffect(() => startWorkspaceWatchSync(queryClient), [queryClient]);
  useEffect(() => {
    document.documentElement.dataset.diffColorScheme = settings.diffColorPalette;
  }, [settings.diffColorPalette]);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const visibleRouteMatch = useRouterState({
    select: (state) => {
      const lastMatch = state.matches.at(-1);
      if (!lastMatch) {
        return null;
      }
      return {
        routeId: lastMatch.routeId,
        params: { ...lastMatch.params },
      };
    },
  });
  const pathnameRef = useRef(pathname);
  const visibleRouteMatchRef = useRef(visibleRouteMatch);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const threadWarmProfileRef = useRef<ThreadWarmProfile>({
    includeFileChanges: settings.showFileChangeDiffsInline,
  });

  pathnameRef.current = pathname;
  visibleRouteMatchRef.current = visibleRouteMatch;
  threadWarmProfileRef.current = {
    includeFileChanges: settings.showFileChangeDiffsInline,
  };

  useEffect(() => {
    const providers = serverConfigQuery.data?.providers;
    if (!providers) return;
    const dismissed = settings.dismissedProviderUpdateAdvisories;
    const providerIds = new Set(providers.map((provider) => provider.instanceId));
    const pruned = Object.fromEntries(
      Object.entries(dismissed).filter(([instanceId]) =>
        providerIds.has(instanceId as ProviderInstanceId),
      ),
    ) as Record<ProviderInstanceId, string>;
    if (Object.keys(pruned).length === Object.keys(dismissed).length) {
      return;
    }
    updateSettings({ dismissedProviderUpdateAdvisories: pruned });
  }, [
    serverConfigQuery.data?.providers,
    settings.dismissedProviderUpdateAdvisories,
    updateSettings,
  ]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    const controller = createOrchestrationSyncController({
      api,
      applyDomainEvent,
      applyDomainEventBatch,
      invalidateThreadDetails,
      syncStartupSnapshot,
      setProjectExpanded,
      syncThreadTailDetails,
      applyTerminalEvent,
      removeOrphanedTerminalStates,
      markRecoveryComplete,
      navigate,
      updateSettings,
      queryClient,
      pathnameRef,
      visibleRouteMatchRef,
      handledBootstrapThreadIdRef,
      threadWarmProfileRef,
      environment: {
        clientKind: window.desktopBridge ? "desktop" : "web",
        raf: (callback) => window.requestAnimationFrame(callback),
        cancelRaf: (id) => window.cancelAnimationFrame(id),
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (id) => window.clearTimeout(id),
        queueMicrotask: (callback) => window.queueMicrotask(callback),
        now: () => performance.now(),
        setInterval: (callback, delay) => window.setInterval(callback, delay),
        clearInterval: (id) => window.clearInterval(id),
        isHidden: () => document.hidden,
        onPageHide: (callback) => {
          window.addEventListener("pagehide", callback);
          return () => window.removeEventListener("pagehide", callback);
        },
        onVisibilityChange: (callback) => {
          document.addEventListener("visibilitychange", callback);
          return () => document.removeEventListener("visibilitychange", callback);
        },
      },
    });
    return () => controller.dispose();
  }, [
    applyDomainEvent,
    applyDomainEventBatch,
    applyTerminalEvent,
    markRecoveryComplete,
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    syncStartupSnapshot,
    syncThreadTailDetails,
    updateSettings,
    invalidateThreadDetails,
  ]);

  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
