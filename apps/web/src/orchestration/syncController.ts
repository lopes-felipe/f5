import { startDeferredClientDiagnostics } from "./deferredClientDiagnostics";
import type { AppSettings } from "../appSettings";
import { startSequenceReconciliation } from "./sequenceReconciliation";
import { getWsConnectionState, subscribeWsConnectionState } from "../wsConnectionState";
import { createOrchestrationEventRouter, type RouterSnapshot } from "../orchestration/eventRouter";
import { invalidateWorkflowQueries } from "../lib/workflowQueries";
import {
  noteWsSynchronized,
  noteWsResynchronizing,
  noteWsSynchronizationError,
} from "../wsConnectionState";
import { useComposerMentionHistoryStore } from "../composerMentionHistoryStore";

import {
  acceptProfileWelcome,
  refreshProfiles,
  useProfileState,
  updateProfileAccounts,
} from "../profileState";
import {
  type ServerProviderAdvisoriesUpdatedPayload,
  type ServerConfig,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadTailDetails,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { QueryClient } from "@tanstack/react-query";

import { toastManager } from "../components/ui/toast";
import {
  withEditorOpenAuthorization,
  resolveAndPersistPreferredEditor,
} from "../editorPreferences";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";

import {
  clearPromotedDraftThreads,
  pruneOrphanedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { nextRewindDraftReadTicket, useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  onProviderAdvisoriesUpdated,
  onServerConfigUpdated,
  onServerWelcome,
} from "../wsNativeApi";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import {
  applyThreadCommandExecutionEventToQueryCache,
  clearInFlightOrchestrationRpcRequests,
  invalidateThreadCommandExecutionDetailQueries,
  orchestrationQueryKeys,
} from "../lib/orchestrationReactQuery";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { invalidateReviewQueries } from "../lib/reviewReactQuery";
import { readAppSettingsSnapshot, type useAppSettings } from "../appSettings";
import { deriveOnboardingLiteState } from "../lib/onboardingLite";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";

import {
  cancelLiveThreadWarmScheduler,
  getLiveThreadWarmThreadIdForDomainEvent,
  preloadRecentThreadDetails,
  RECENT_THREAD_PRELOAD_COUNT,
  scheduleLiveThreadWarmForDomainEvent,
  warmThreadBundle,
  type ThreadWarmProfile,
} from "../lib/threadPreload";

import {
  invalidateAllWorkspaceQueries,
  invalidateWorkspaceForEvent,
  isWorkspaceEffectEvent,
  type ThreadWorkspace,
} from "../lib/workspaceInvalidation";

import { affectsWorktreeInventory } from "../lib/worktreeInventoryInvalidation";

import type { NativeApi } from "@t3tools/contracts";
import type { EventRouterScheduler } from "./eventRouter";

export function applyProviderAdvisoriesToServerConfig(
  existing: ServerConfig | undefined,
  payload: ServerProviderAdvisoriesUpdatedPayload,
): ServerConfig | undefined {
  if (!existing) return existing;
  const byId = new Map(
    payload.advisories.map((entry) => [entry.instanceId, entry.versionAdvisory] as const),
  );
  const providers = existing.providers.map((provider) => {
    const advisory = byId.get(provider.instanceId);
    if (!advisory) {
      if (!provider.versionAdvisory) return provider;
      const { versionAdvisory: _versionAdvisory, ...rest } = provider;
      return rest;
    }
    return { ...provider, versionAdvisory: advisory };
  });
  return { ...existing, providers };
}

export type VisibleRouteMatch = {
  routeId: string;
  params: Record<string, string | undefined>;
} | null;

function resolveVisibleThreadDetailId(input: {
  routeMatch: VisibleRouteMatch;
  fallbackThreadId?: ThreadId | null;
  codeReviewWorkflows: ReadonlyArray<{
    id: string;
    consolidation: { threadId: ThreadId | null };
  }>;
  investigationWorkflows: ReadonlyArray<{
    id: string;
    synthesis: { threadId: ThreadId | null };
  }>;
}): ThreadId | null {
  if (input.routeMatch?.routeId === "/_chat/$threadId") {
    const threadId = input.routeMatch.params.threadId;
    return threadId ? ThreadId.makeUnsafe(threadId) : (input.fallbackThreadId ?? null);
  }

  if (input.routeMatch?.routeId === "/_chat/code-review/$workflowId") {
    const workflowId = input.routeMatch.params.workflowId;
    if (!workflowId) {
      return input.fallbackThreadId ?? null;
    }
    return (
      input.codeReviewWorkflows.find((workflow) => workflow.id === workflowId)?.consolidation
        .threadId ??
      input.fallbackThreadId ??
      null
    );
  }

  if (
    input.routeMatch?.routeId === "/_chat/investigation/$workflowId" ||
    input.routeMatch?.routeId === "/_chat/debug/$workflowId"
  ) {
    const workflowId = input.routeMatch.params.workflowId;
    if (!workflowId) {
      return input.fallbackThreadId ?? null;
    }
    return (
      input.investigationWorkflows.find((workflow) => workflow.id === workflowId)?.synthesis
        .threadId ??
      input.fallbackThreadId ??
      null
    );
  }

  return input.fallbackThreadId ?? null;
}

function resolveStartupDetailThreadId(input: {
  routeMatch: VisibleRouteMatch;
  fallbackThreadId?: ThreadId | null;
  codeReviewWorkflows: ReadonlyArray<{
    id: string;
    consolidation: { threadId: ThreadId | null };
  }>;
  investigationWorkflows: ReadonlyArray<{
    id: string;
    synthesis: { threadId: ThreadId | null };
  }>;
}): ThreadId | null {
  if (input.routeMatch?.routeId === "/_chat/$threadId") {
    const threadId = input.routeMatch.params.threadId;
    return threadId ? ThreadId.makeUnsafe(threadId) : (input.fallbackThreadId ?? null);
  }

  if (input.routeMatch?.routeId === "/_chat/code-review/$workflowId") {
    const workflowId = input.routeMatch.params.workflowId;
    if (!workflowId) {
      return input.fallbackThreadId ?? null;
    }
    return (
      input.codeReviewWorkflows.find((workflow) => workflow.id === workflowId)?.consolidation
        .threadId ??
      input.fallbackThreadId ??
      null
    );
  }

  if (
    input.routeMatch?.routeId === "/_chat/investigation/$workflowId" ||
    input.routeMatch?.routeId === "/_chat/debug/$workflowId"
  ) {
    const workflowId = input.routeMatch.params.workflowId;
    if (!workflowId) {
      return input.fallbackThreadId ?? null;
    }
    return (
      input.investigationWorkflows.find((workflow) => workflow.id === workflowId)?.synthesis
        .threadId ??
      input.fallbackThreadId ??
      null
    );
  }

  if (input.routeMatch === null || input.routeMatch.routeId === "/_chat/") {
    return input.fallbackThreadId ?? null;
  }

  return null;
}

function collectValidProjectIds(
  projects: ReadonlyArray<{
    id: string;
  }>,
): ReadonlySet<string> {
  return new Set(projects.map((project) => project.id));
}

export function pruneDraftThreadsForCurrentProjects(): void {
  pruneOrphanedDraftThreads(collectValidProjectIds(useStore.getState().projects));
}

export function reconcileDraftThreadsAfterStartupSnapshot(
  snapshot: Pick<OrchestrationReadModel, "projects" | "threads">,
): void {
  pruneOrphanedDraftThreads(
    collectValidProjectIds(snapshot.projects.filter((project) => project.deletedAt === null)),
  );
  clearPromotedDraftThreads(new Set(snapshot.threads.map((thread) => thread.id)));
}

type StoreActions = Pick<
  ReturnType<typeof useStore.getState>,
  | "applyDomainEvent"
  | "applyDomainEventBatch"
  | "invalidateThreadDetails"
  | "syncStartupSnapshot"
  | "setProjectExpanded"
  | "syncThreadTailDetails"
>;
interface Current<T> {
  current: T;
}
export interface SyncControllerEnvironment extends EventRouterScheduler {
  readonly clientKind: "desktop" | "web";
  readonly now: () => number;
  readonly setInterval: (callback: () => void, delayMs: number) => number;
  readonly clearInterval: (id: number) => void;
  readonly isHidden: () => boolean;
  readonly onVisibilityChange: (callback: () => void) => () => void;
  readonly onPageHide: (callback: () => void) => () => void;
}
export interface OrchestrationSyncControllerDeps extends StoreActions {
  readonly api: NativeApi;
  readonly environment: SyncControllerEnvironment;
  readonly queryClient: QueryClient;
  readonly applyTerminalEvent: ReturnType<
    typeof useTerminalStateStore.getState
  >["applyTerminalEvent"];
  readonly removeOrphanedTerminalStates: ReturnType<
    typeof useTerminalStateStore.getState
  >["removeOrphanedTerminalStates"];
  readonly markRecoveryComplete: () => void;
  readonly navigate: (options: {
    to: "/$threadId";
    params: { threadId: string };
    replace: boolean;
  }) => Promise<void>;
  readonly updateSettings: ReturnType<typeof useAppSettings>["updateSettings"];
  readonly pathnameRef: Current<string>;
  readonly visibleRouteMatchRef: Current<VisibleRouteMatch>;
  readonly handledBootstrapThreadIdRef: Current<string | null>;
  readonly threadWarmProfileRef: Current<ThreadWarmProfile>;
}

/** Owns synchronization lifetime; React supplies routing, settings and browser scheduling. */
export function createOrchestrationSyncController(deps: OrchestrationSyncControllerDeps) {
  const {
    api,
    environment,
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
  } = deps;
  let disposed = false;
  const poisonedLoadedThreadIds = new Set<ThreadId>();
  let nextWelcomeRecoveryId = 0;
  let pendingWelcomeRecovery: { id: number; payload: WsWelcomePayload } | null = null;
  let pendingCommandExecutionDetailInvalidation = false;
  let latestWelcomeReceivedAtMs: number | null = null;
  let hasPreloadedRecentThreads = false;
  let activeDetailPrefetchController: AbortController | null = null;
  const makeAbortError = (): Error => {
    if (typeof DOMException !== "undefined") {
      return new DOMException("The operation was aborted.", "AbortError");
    }
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  };

  const isAbortError = (error: unknown): boolean =>
    error instanceof Error && error.name === "AbortError";

  const resolveThreadWorkspace = (threadId: ThreadId): ThreadWorkspace | null => {
    const { threads, projects } = useStore.getState();
    const thread = threads.find((entry) => entry.id === threadId);
    const project = thread ? projects.find((entry) => entry.id === thread.projectId) : undefined;
    const cwd = threadWorkspaceCwd(thread, project);
    return thread && cwd ? { cwd, projectId: thread.projectId } : null;
  };
  // Turn diffs and reverts refresh the affected workspace (file contents,
  // listings, the @-mention picker's entries); events from an unknown
  // workspace refresh every workspace.
  const invalidateWorkspaceQueriesForEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
    for (const event of events) {
      if (!isWorkspaceEffectEvent(event)) continue;
      if (invalidateWorkspaceForEvent(queryClient, event, resolveThreadWorkspace) === "broad") {
        return;
      }
    }
  };

  const removeOrphanedTerminalsForCurrentStoreThreads = () => {
    const draftThreadIds = Object.keys(
      useComposerDraftStore.getState().draftThreadsByThreadId,
    ) as ThreadId[];
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: useStore
        .getState()
        .threads.map((thread) => ({ id: thread.id, deletedAt: null })),
      draftThreadIds,
    });
    removeOrphanedTerminalStates(activeThreadIds);
    useStore.getState().pruneChangedFilesExpandedForThreads(activeThreadIds);
  };

  const abortActiveDetailPrefetches = () => {
    if (!activeDetailPrefetchController) {
      cancelLiveThreadWarmScheduler(makeAbortError());
      clearInFlightOrchestrationRpcRequests();
      return;
    }
    activeDetailPrefetchController.abort();
    activeDetailPrefetchController = null;
    cancelLiveThreadWarmScheduler(makeAbortError());
    clearInFlightOrchestrationRpcRequests();
  };

  const ensureActiveDetailPrefetchSignal = () => {
    if (!activeDetailPrefetchController) {
      activeDetailPrefetchController = new AbortController();
    }
    return activeDetailPrefetchController.signal;
  };

  const getFreshDetailPrefetchSignal = () => {
    abortActiveDetailPrefetches();
    activeDetailPrefetchController = new AbortController();
    return activeDetailPrefetchController.signal;
  };

  const isPreservedThreadScopedOrchestrationQuery = (
    queryKey: readonly unknown[],
    preservedThreadIds: ReadonlySet<ThreadId>,
  ) => {
    if (queryKey[0] !== orchestrationQueryKeys.all[0]) {
      return false;
    }
    const scopedThreadId = queryKey[2];
    return typeof scopedThreadId === "string" && preservedThreadIds.has(scopedThreadId as ThreadId);
  };

  const applyEventToStore = (event: OrchestrationEvent) => {
    // These side effects must remain idempotent because the same event can
    // be observed both live and again during recovery after a transport gap.
    applyDomainEvent(event);
    switch (event.type) {
      case "thread.deleted":
      case "thread.reverted":
      case "thread.command-execution-recorded":
      case "thread.command-execution-output-appended":
        applyThreadCommandExecutionEventToQueryCache(queryClient, event);
        break;
      default:
        break;
    }
    if (event.type === "thread.created") {
      clearPromotedDraftThreads(new Set(useStore.getState().threads.map((thread) => thread.id)));
    }
    if (event.type === "project.deleted") {
      useComposerMentionHistoryStore
        .getState()
        .retainThreads(new Set(useStore.getState().threads.map((thread) => thread.id)));
      pruneDraftThreadsForCurrentProjects();
      removeOrphanedTerminalsForCurrentStoreThreads();
    }
    if (event.type === "thread.deleted") {
      useComposerMentionHistoryStore.getState().forgetThread(event.payload.threadId);
      removeOrphanedTerminalsForCurrentStoreThreads();
    }
    void invalidateWorkflowQueries(queryClient, [event]);
    invalidateWorkspaceQueriesForEvents([event]);
  };

  const applyBatchToStore = (batch: ReadonlyArray<OrchestrationEvent>) => {
    applyDomainEventBatch(batch);
    // Replicate the side-effects guarded by applyEventToStore, but only run
    // each side effect once per flush even if the batch contained multiple
    // matching events. The query-invalidation side effect has moved here
    // from the subscription callback so it observes the post-commit store
    // state rather than racing with the pending frame.
    let sawThreadCreated = false;
    let sawThreadDeleted = false;
    let sawProjectDeleted = false;
    for (const event of batch) {
      if (event.type === "thread.created") sawThreadCreated = true;
      if (event.type === "thread.deleted") sawThreadDeleted = true;
      if (event.type === "project.deleted") sawProjectDeleted = true;
      switch (event.type) {
        case "thread.deleted":
        case "thread.reverted":
        case "thread.command-execution-recorded":
        case "thread.command-execution-output-appended":
          applyThreadCommandExecutionEventToQueryCache(queryClient, event);
          break;
        default:
          break;
      }
    }
    if (sawThreadCreated) {
      clearPromotedDraftThreads(new Set(useStore.getState().threads.map((thread) => thread.id)));
    }
    if (sawProjectDeleted) {
      pruneDraftThreadsForCurrentProjects();
    }
    if (sawProjectDeleted || sawThreadDeleted) {
      useComposerMentionHistoryStore
        .getState()
        .retainThreads(new Set(useStore.getState().threads.map((thread) => thread.id)));
      removeOrphanedTerminalsForCurrentStoreThreads();
    }
    void invalidateWorkflowQueries(queryClient, batch);
    if (batch.some(affectsWorktreeInventory))
      void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
    invalidateWorkspaceQueriesForEvents(batch);
    if (import.meta.env.DEV && batch.length >= 64) {
      console.info("EventRouter coalesced a large batch", {
        size: batch.length,
        firstSequence: batch[0]?.sequence,
        lastSequence: batch[batch.length - 1]?.sequence,
      });
    }
  };

  const completeWelcomeRecovery = async (): Promise<ThreadId | null> => {
    if (!pendingWelcomeRecovery || disposed) {
      return null;
    }

    const { payload } = pendingWelcomeRecovery;
    pendingWelcomeRecovery = null;
    markRecoveryComplete();

    if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
      return null;
    }
    setProjectExpanded(payload.bootstrapProjectId, true);

    if (pathnameRef.current !== "/") {
      return null;
    }
    if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
      return payload.bootstrapThreadId;
    }
    await navigate({
      to: "/$threadId",
      params: { threadId: payload.bootstrapThreadId },
      replace: true,
    });
    handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    return payload.bootstrapThreadId;
  };

  const resolveCurrentVisibleThreadDetailId = (fallbackThreadId?: ThreadId | null) =>
    resolveVisibleThreadDetailId({
      routeMatch: visibleRouteMatchRef.current,
      ...(fallbackThreadId !== undefined ? { fallbackThreadId } : {}),
      codeReviewWorkflows: useStore.getState().codeReviewWorkflows,
      investigationWorkflows: useStore.getState().investigationWorkflows,
    });

  const warmVisibleThreadBundle = async (options?: {
    fallbackThreadId?: ThreadId | null;
    signal?: AbortSignal;
    forceThreadDetails?: boolean;
    initialDetails?: OrchestrationThreadTailDetails | null;
  }) => {
    const visibleThreadId = resolveCurrentVisibleThreadDetailId(options?.fallbackThreadId);
    if (!visibleThreadId) {
      return;
    }
    try {
      await warmThreadBundle(queryClient, visibleThreadId, {
        ...(options?.forceThreadDetails !== undefined
          ? { forceThreadDetails: options.forceThreadDetails }
          : {}),
        initialDetails: options?.initialDetails ?? null,
        ...(options?.signal ? { signal: options.signal } : {}),
        warmProfile: threadWarmProfileRef.current,
      });
      const visibleThread = useStore
        .getState()
        .threads.find((thread) => thread.id === visibleThreadId);
      if (import.meta.env.DEV && visibleThread?.detailsLoaded) {
        console.info("thread bundle visible", {
          threadId: visibleThreadId,
          durationMs: latestWelcomeReceivedAtMs
            ? Math.round(environment.now() - latestWelcomeReceivedAtMs)
            : null,
        });
      }
    } catch (error) {
      console.warn("Failed to warm visible thread bundle.", {
        threadId: visibleThreadId,
        error,
      });
    }
  };

  const readSnapshot = async (): Promise<RouterSnapshot> => {
    const pendingBootstrapThreadId =
      pathnameRef.current === "/"
        ? (pendingWelcomeRecovery?.payload.bootstrapThreadId ?? null)
        : null;
    const startupDetailThreadId = resolveStartupDetailThreadId({
      routeMatch: visibleRouteMatchRef.current,
      fallbackThreadId: pendingBootstrapThreadId,
      codeReviewWorkflows: useStore.getState().codeReviewWorkflows,
      investigationWorkflows: useStore.getState().investigationWorkflows,
    });
    // Taken before the request so a `getRewindDrafts` read that starts
    // later wins, even if this snapshot response lands after it.
    const rewindDraftReadTicket = nextRewindDraftReadTicket();
    const startupResult = await api.orchestration.getStartupSnapshot(
      startupDetailThreadId ? { detailThreadId: startupDetailThreadId } : undefined,
    );
    const snapshot = startupResult.snapshot;
    const bundledThreadTailDetails = startupResult.threadTailDetails;
    const snapshotIsProvisional =
      snapshot.snapshotSequence === 0 &&
      (snapshot.projects.length > 0 ||
        snapshot.threads.length > 0 ||
        snapshot.planningWorkflows.length > 0 ||
        snapshot.codeReviewWorkflows.length > 0);
    const visibleThreadIdForSnapshot = resolveVisibleThreadDetailId({
      routeMatch: visibleRouteMatchRef.current,
      fallbackThreadId: pendingBootstrapThreadId,
      codeReviewWorkflows: snapshot.codeReviewWorkflows
        .filter((workflow) => workflow.deletedAt === null)
        .map((workflow) => ({
          id: workflow.id,
          consolidation: { threadId: workflow.consolidation.threadId },
        })),
      investigationWorkflows: snapshot.investigationWorkflows
        .filter((workflow) => workflow.deletedAt === null)
        .map((workflow) => ({
          id: workflow.id,
          synthesis: { threadId: workflow.synthesis.threadId },
        })),
    });
    const bufferedVisibleThreadId = visibleThreadIdForSnapshot;
    return {
      sequence: snapshot.snapshotSequence,
      provisional: snapshotIsProvisional,
      merge: () => {
        if (pendingWelcomeRecovery !== null) {
          // Turns may have finished while disconnected.
          invalidateAllWorkspaceQueries(queryClient);
          // Cancel any older startup/recovery prefetch work before invalidating.
          // Signaled callers skip their late store writes, so an old RPC
          // response cannot repopulate the query cache or Zustand after we clear
          // non-preserved thread state below.
          abortActiveDetailPrefetches();
          const preservedIds = new Set<ThreadId>(
            visibleThreadIdForSnapshot ? [visibleThreadIdForSnapshot] : [],
          );
          queryClient.removeQueries({
            predicate: (query) =>
              Array.isArray(query.queryKey) &&
              query.queryKey[0] === orchestrationQueryKeys.all[0] &&
              !isPreservedThreadScopedOrchestrationQuery(query.queryKey, preservedIds),
          });
          invalidateThreadDetails({
            preserveThreadIds: visibleThreadIdForSnapshot ? [visibleThreadIdForSnapshot] : [],
          });
          // Refresh orchestration queries except for the preserved visible
          // thread, which we prefetch explicitly below using the fresh snapshot.
          void queryClient.invalidateQueries({
            predicate: (query) =>
              Array.isArray(query.queryKey) &&
              query.queryKey[0] === orchestrationQueryKeys.all[0] &&
              !isPreservedThreadScopedOrchestrationQuery(query.queryKey, preservedIds),
          });
        }
        syncStartupSnapshot(snapshot, { rewindDraftReadTicket });
        void invalidateWorkflowQueries(queryClient);
        if (!snapshotIsProvisional) {
          useComposerMentionHistoryStore
            .getState()
            .retainThreads(
              new Set(
                snapshot.threads
                  .filter((thread) => thread.deletedAt === null)
                  .map((thread) => thread.id),
              ),
            );
        }
        reconcileDraftThreadsAfterStartupSnapshot(snapshot);
        if (startupDetailThreadId && bundledThreadTailDetails) {
          queryClient.setQueryData(
            orchestrationQueryKeys.threadDetails(startupDetailThreadId),
            bundledThreadTailDetails,
          );
          syncThreadTailDetails(startupDetailThreadId, bundledThreadTailDetails);
        }
        if (pendingCommandExecutionDetailInvalidation) {
          pendingCommandExecutionDetailInvalidation = false;
          void invalidateThreadCommandExecutionDetailQueries(queryClient);
        }
        if (import.meta.env.DEV && latestWelcomeReceivedAtMs !== null) {
          console.info("startup snapshot hydrated", {
            durationMs: Math.round(environment.now() - latestWelcomeReceivedAtMs),
            threadCount: snapshot.threads.length,
            projectCount: snapshot.projects.length,
          });
        }
        const draftThreadIds = Object.keys(
          useComposerDraftStore.getState().draftThreadsByThreadId,
        ) as ThreadId[];
        const activeThreadIds = collectActiveTerminalThreadIds({
          snapshotThreads: snapshot.threads,
          draftThreadIds,
        });
        removeOrphanedTerminalStates(activeThreadIds);
        useStore.getState().pruneChangedFilesExpandedForThreads(activeThreadIds);
      },
      finish: async () => {
        const recoveredBootstrapThreadId = await completeWelcomeRecovery();
        if (disposed) return;
        const onboardingLiteState = deriveOnboardingLiteState({
          // Read at recovery time; the root subscribes only to the settings it renders.
          settings: readAppSettingsSnapshot(),
          projects: useStore.getState().projects,
          threads: useStore.getState().threads,
          draftThreadsByProjectId: new Map(
            Object.entries(useComposerDraftStore.getState().projectDraftThreadIdByProjectId),
          ),
          threadsHydrated: useStore.getState().threadsHydrated,
          recoveryEpoch: useRecoveryStateStore.getState().recoveryEpoch,
        });
        if (onboardingLiteState.shouldPromoteToCompleted) {
          updateSettings({ onboardingLiteStatus: "completed" });
        }
        const shouldWarmVisibleThread = bufferedVisibleThreadId !== null;
        const shouldWarmBootstrapThread =
          recoveredBootstrapThreadId !== null &&
          recoveredBootstrapThreadId !== bufferedVisibleThreadId;
        const bundledThreadId =
          startupDetailThreadId && bundledThreadTailDetails ? startupDetailThreadId : null;
        const alreadyWarmed = new Set<ThreadId>();
        if (bufferedVisibleThreadId) alreadyWarmed.add(bufferedVisibleThreadId);
        if (recoveredBootstrapThreadId) alreadyWarmed.add(recoveredBootstrapThreadId);
        const remainingBudget = RECENT_THREAD_PRELOAD_COUNT - alreadyWarmed.size;
        const shouldRunRecentThreadPreload =
          !snapshotIsProvisional && !hasPreloadedRecentThreads && remainingBudget > 0;

        if (shouldWarmVisibleThread || shouldWarmBootstrapThread || shouldRunRecentThreadPreload) {
          const detailPrefetchSignal = getFreshDetailPrefetchSignal();
          if (bufferedVisibleThreadId) {
            void warmVisibleThreadBundle({
              fallbackThreadId: bufferedVisibleThreadId,
              signal: detailPrefetchSignal,
              forceThreadDetails: bundledThreadId !== bufferedVisibleThreadId,
              initialDetails:
                bundledThreadId === bufferedVisibleThreadId ? bundledThreadTailDetails : null,
            });
          }
          if (shouldWarmBootstrapThread) {
            void warmVisibleThreadBundle({
              fallbackThreadId: recoveredBootstrapThreadId,
              signal: detailPrefetchSignal,
              forceThreadDetails: true,
            });
          }
          if (shouldRunRecentThreadPreload) {
            hasPreloadedRecentThreads = true;
            void preloadRecentThreadDetails(queryClient, {
              limit: remainingBudget,
              signal: detailPrefetchSignal,
              excludeThreadIds: Array.from(alreadyWarmed),
              warmProfile: threadWarmProfileRef.current,
            });
          }
        }
      },
    };
  };

  const router = createOrchestrationEventRouter({
    api: { readSnapshot },
    actions: {
      applyBatch: applyBatchToStore,
      applyEvent: applyEventToStore,
      onGap: () => invalidateAllWorkspaceQueries(queryClient),
      onResynchronizing: noteWsResynchronizing,
      onSynchronized: () => {
        noteWsSynchronized();
        void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
      },
      onRecoveryError: noteWsSynchronizationError,
      logPoison: (batch, error) => {
        abortActiveDetailPrefetches();
        const ids = new Set(
          batch
            .filter((event) => event.aggregateKind === "thread")
            .map((event) => event.aggregateId),
        );
        for (const thread of useStore.getState().threads)
          if (thread.detailsLoaded && ids.has(thread.id)) poisonedLoadedThreadIds.add(thread.id);
        console.error("EventRouter discarded a failing batch", {
          firstSequence: batch[0]?.sequence,
          lastSequence: batch.at(-1)?.sequence,
          error,
        });
      },
      repairThreads: (threadIds) => {
        const state = useStore.getState();
        const loadedIds = state.threads
          .filter(
            (thread) =>
              threadIds.has(thread.id) &&
              (thread.detailsLoaded || poisonedLoadedThreadIds.has(thread.id)),
          )
          .map((thread) => thread.id);
        poisonedLoadedThreadIds.clear();
        for (const id of threadIds) state.resetThreadDetailBuffer(id);
        clearInFlightOrchestrationRpcRequests();
        const affected = {
          predicate: (query: { queryKey: readonly unknown[] }) =>
            query.queryKey[0] === orchestrationQueryKeys.all[0] &&
            threadIds.has(query.queryKey[2] as ThreadId),
        };
        void queryClient.cancelQueries(affected);
        void queryClient.invalidateQueries(affected);
        for (const id of loadedIds)
          void warmThreadBundle(queryClient, id, {
            forceThreadDetails: true,
            signal: ensureActiveDetailPrefetchSignal(),
            warmProfile: threadWarmProfileRef.current,
          }).catch((error) => {
            if (!isAbortError(error))
              console.warn("Failed to repair thread after synchronization failure", {
                threadId: id,
                error,
              });
          });
      },
    },
    scheduler: {
      raf: (callback) => environment.raf(callback),
      cancelRaf: (id) => environment.cancelRaf(id),
      setTimeout: (callback, delayMs) => environment.setTimeout(callback, delayMs),
      clearTimeout: (id) => environment.clearTimeout(id),
      queueMicrotask: (callback) => environment.queueMicrotask(callback),
    },
    now: () => environment.now(),
  });
  const { flushPending, syncSnapshot, clearSnapshotRetry, waitForCommittedSequence } = router;
  const diagnostics = startDeferredClientDiagnostics({
    read: router.getDiagnostics,
    report: api.server.reportClientDiagnostics,
    clientKind: environment.clientKind,
    connected: () => getWsConnectionState().phase === "connected",
    subscribeConnection: subscribeWsConnectionState,
    onHidden: (callback) => {
      const visibility = environment.onVisibilityChange(() => {
        if (environment.isHidden()) callback();
      });
      const pageHide = environment.onPageHide(callback);
      return () => {
        visibility();
        pageHide();
      };
    },
    now: environment.now,
    scheduler: environment,
  });

  const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
    if (event.sequence <= router.latestSequence || router.breakerOpen) return;
    if (event.type === "project.created" || event.type === "project.meta-updated")
      void refreshProfiles()
        .then(() => {
          const warnings = useProfileState.getState().active?.sharedRepositories ?? [];
          for (const warning of warnings.filter(
            (warning) => warning.workspaceRoot === event.payload.workspaceRoot,
          ))
            toastManager.add({
              type: "info",
              title: "Repository shared with another profile",
              description: `${warning.workspaceRoot} is also registered in ${warning.otherProfiles.join(", ")}. Linked worktrees share Git metadata.`,
            });
        })
        .catch(() => {});
    // This must run before the event enters any reducer path so unloaded
    // threads have a retained detail buffer when the same event is applied.
    // The scheduler only creates the buffer synchronously here; the actual
    // tail fetch starts later in a bounded queue after EventRouter commits
    // this sequence itself, or after a short fallback timeout if that commit
    // is stalled.
    const liveWarmThreadId = getLiveThreadWarmThreadIdForDomainEvent(event);
    if (liveWarmThreadId !== null) {
      scheduleLiveThreadWarmForDomainEvent(queryClient, event, {
        signal: ensureActiveDetailPrefetchSignal(),
        waitUntilSequenceCommitted: waitForCommittedSequence,
      })?.catch((error) => {
        if (isAbortError(error)) {
          return;
        }
        console.warn("Failed to warm background thread bundle.", {
          threadId: liveWarmThreadId,
          error,
        });
      });
    }
    router.receive(event);
  });
  const unsubTerminalEvent = api.terminal.onEvent((event) => {
    applyTerminalEvent(event);
  });
  const unsubWelcome = onServerWelcome((payload) => {
    if (!acceptProfileWelcome(payload)) return;
    router.invalidateSnapshot();
    noteWsResynchronizing();
    const previous = useStore.getState().backendIncarnation;
    if (payload.backendIncarnation && previous !== payload.backendIncarnation) {
      if (previous !== undefined) {
        abortActiveDetailPrefetches();
        clearInFlightOrchestrationRpcRequests();
        router.resetStream();
        useStore.getState().resetBackendState(payload.backendIncarnation);
        queryClient.removeQueries({ queryKey: orchestrationQueryKeys.all });
      } else useStore.setState({ backendIncarnation: payload.backendIncarnation });
    }
    pendingWelcomeRecovery = { id: ++nextWelcomeRecoveryId, payload };
    pendingCommandExecutionDetailInvalidation = true;
    latestWelcomeReceivedAtMs = environment.now();
    clearSnapshotRetry();
    void syncSnapshot();
  });
  const reconciliation = startSequenceReconciliation({
    probe: () => api.orchestration.getLatestSequence(),
    committedSequence: () => router.committedSequence,
    incarnation: () => useStore.getState().backendIncarnation,
    recoverIncarnation: async (incarnation) => {
      abortActiveDetailPrefetches();
      router.resetStream();
      useStore.getState().resetBackendState(incarnation);
      queryClient.removeQueries({ queryKey: orchestrationQueryKeys.all });
      await syncSnapshot();
    },
    waitForSequence: waitForCommittedSequence,
    syncSnapshot: async () => {
      flushPending();
      if (!router.syncing && !router.hasSnapshotRetry) await syncSnapshot();
    },
    connected: () => getWsConnectionState().phase === "connected",
    subscribeConnection: subscribeWsConnectionState,
    scheduler: environment,
    now: environment.now,
  });
  // rAF does not run while the tab is hidden, so token deltas arriving in
  // the background accumulate in `pendingEvents`. On foregrounding we
  // immediately apply whatever queued up so the first paint shows current
  // state. (The MAX_PENDING_EVENTS cap still bounds memory growth while
  // hidden.)
  const handleVisibilityChange = () => {
    if (!environment.isHidden()) {
      flushPending();
    }
  };
  const unsubscribeVisibility = environment.onVisibilityChange(handleVisibilityChange);
  // onServerConfigUpdated replays the latest cached value synchronously
  // during subscribe. Skip the toast for that replay so effect re-runs
  // don't produce duplicate toasts.
  let subscribed = false;
  const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
    updateProfileAccounts(payload.providers);
    void queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
    if (!subscribed) return;
    if (payload.source !== "keybindings") return;
    const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
    if (!issue) {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    toastManager.add({
      type: "warning",
      title: "Invalid keybindings configuration",
      description: issue.message,
      actionProps: {
        children: "Open keybindings.json",
        onClick: () => {
          void withEditorOpenAuthorization(undefined, async (authorization) => {
            const config = await queryClient.ensureQueryData(serverConfigQueryOptions());
            const editor = resolveAndPersistPreferredEditor(config.availableEditors);
            if (!editor) {
              throw new Error("No available editors found.");
            }
            return authorization
              ? api.shell.openInEditor(config.keybindingsConfigPath, editor, authorization)
              : api.shell.openInEditor(config.keybindingsConfigPath, editor);
          }).catch((error) => {
            toastManager.add({
              type: "error",
              title: "Unable to open keybindings file",
              description: error instanceof Error ? error.message : "Unknown error opening file.",
            });
          });
        },
      },
    });
  });
  subscribed = true;
  const unsubProviderAdvisoriesUpdated = onProviderAdvisoriesUpdated((payload) => {
    queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (existing) =>
      applyProviderAdvisoriesToServerConfig(existing, payload),
    );
  });
  const unsubGitStatusInvalidated = api.git.onStatusInvalidated((payload) => {
    void invalidateGitQueries(queryClient, { cwd: payload.cwd });
    void invalidateReviewQueries(queryClient);
  });
  return {
    dispose: () => {
      disposed = true;
      router.dispose();
      diagnostics.dispose();
      abortActiveDetailPrefetches();
      reconciliation.dispose();
      unsubscribeVisibility();
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
      unsubProviderAdvisoriesUpdated();
      unsubGitStatusInvalidated();
    },
  };
}
