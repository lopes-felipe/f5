import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadTailDetails,
  type WsWelcomePayload,
} from "@t3tools/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import {
  SlowRpcWarningToastCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import {
  clearPromotedDraftThreads,
  pruneOrphanedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { onMcpStatusUpdated, onServerConfigUpdated, onServerWelcome } from "../wsNativeApi";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import {
  applyThreadCommandExecutionEventToQueryCache,
  clearInFlightOrchestrationRpcRequests,
  invalidateThreadCommandExecutionDetailQueries,
  orchestrationQueryKeys,
} from "../lib/orchestrationReactQuery";
import { mcpQueryKeys } from "../lib/mcpReactQuery";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { useAppSettings } from "../appSettings";
import { deriveOnboardingLiteState } from "../lib/onboardingLite";
import {
  cancelLiveThreadWarmScheduler,
  getLiveThreadWarmThreadIdForDomainEvent,
  preloadRecentThreadDetails,
  RECENT_THREAD_PRELOAD_COUNT,
  scheduleLiveThreadWarmForDomainEvent,
  warmThreadBundle,
  type ThreadWarmProfile,
} from "../lib/threadPreload";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
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
        <SlowRpcWarningToastCoordinator />
        <WebSocketConnectionSurface>
          <Outlet />
        </WebSocketConnectionSurface>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

type VisibleRouteMatch = {
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

  return input.fallbackThreadId ?? null;
}

function resolveStartupDetailThreadId(input: {
  routeMatch: VisibleRouteMatch;
  fallbackThreadId?: ThreadId | null;
}): ThreadId | null {
  if (input.routeMatch?.routeId === "/_chat/$threadId") {
    const threadId = input.routeMatch.params.threadId;
    return threadId ? ThreadId.makeUnsafe(threadId) : (input.fallbackThreadId ?? null);
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

export function reconcileDraftThreadsAfterStartupSnapshot(snapshot: OrchestrationReadModel): void {
  pruneOrphanedDraftThreads(
    collectValidProjectIds(snapshot.projects.filter((project) => project.deletedAt === null)),
  );
  clearPromotedDraftThreads(new Set(snapshot.threads.map((thread) => thread.id)));
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
  const navigate = useNavigate();
  const { settings, updateSettings } = useAppSettings();
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
  const appSettingsRef = useRef(settings);
  const threadWarmProfileRef = useRef<ThreadWarmProfile>({
    includeFileChanges: settings.showFileChangeDiffsInline,
  });

  pathnameRef.current = pathname;
  visibleRouteMatchRef.current = visibleRouteMatch;
  appSettingsRef.current = settings;
  threadWarmProfileRef.current = {
    includeFileChanges: settings.showFileChangeDiffsInline,
  };

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let latestSequence = 0;
    // Highest sequence EventRouter itself has committed via live-event apply or
    // full snapshot merge. Do not substitute store.lastAppliedSequence here:
    // thread-tail RPCs can advance that store watermark without proving the
    // websocket stream has delivered every intervening global event.
    let committedSequence = 0;
    let syncing = false;
    let pendingSnapshot = false;
    let bufferedEvents: OrchestrationEvent[] = [];
    let snapshotRetryAttempt = 0;
    let snapshotRetryTimeoutId: number | null = null;
    let nextWelcomeRecoveryId = 0;
    let pendingWelcomeRecovery: { id: number; payload: WsWelcomePayload } | null = null;
    let pendingCommandExecutionDetailInvalidation = false;
    let latestWelcomeReceivedAtMs: number | null = null;
    let hasPreloadedRecentThreads = false;
    let activeDetailPrefetchController: AbortController | null = null;
    type SequenceCommitWaiter = {
      readonly targetSequenceInclusive: number;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
      readonly signal?: AbortSignal;
    };
    let sequenceCommitWaiters: SequenceCommitWaiter[] = [];

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

    const flushSequenceCommitWaiters = () => {
      if (sequenceCommitWaiters.length === 0) {
        return;
      }
      const pendingWaiters = sequenceCommitWaiters;
      sequenceCommitWaiters = [];
      for (const waiter of pendingWaiters) {
        if (waiter.signal?.aborted) {
          waiter.reject(makeAbortError());
          continue;
        }
        if (committedSequence >= waiter.targetSequenceInclusive) {
          waiter.resolve();
          continue;
        }
        sequenceCommitWaiters.push(waiter);
      }
    };

    const rejectSequenceCommitWaiters = (error: unknown) => {
      if (sequenceCommitWaiters.length === 0) {
        return;
      }
      const pendingWaiters = sequenceCommitWaiters;
      sequenceCommitWaiters = [];
      for (const waiter of pendingWaiters) {
        waiter.reject(error);
      }
    };

    const invalidateProviderAndProjectQueries = () => {
      void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      // Invalidate workspace entry queries so the @-mention file picker
      // reflects files created, deleted, or restored during this turn.
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
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

    const waitForCommittedSequence = (
      targetSequenceInclusive: number,
      signal?: AbortSignal,
    ): Promise<void> => {
      if (committedSequence >= targetSequenceInclusive) {
        return Promise.resolve();
      }
      if (signal?.aborted) {
        return Promise.reject(makeAbortError());
      }

      return new Promise((resolve, reject) => {
        let waiter!: SequenceCommitWaiter;
        const onAbort = () => {
          sequenceCommitWaiters = sequenceCommitWaiters.filter((entry) => entry !== waiter);
          reject(makeAbortError());
        };
        waiter = {
          targetSequenceInclusive,
          resolve: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
          ...(signal ? { signal } : {}),
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        sequenceCommitWaiters.push(waiter);
      });
    };

    const isPreservedThreadScopedOrchestrationQuery = (
      queryKey: readonly unknown[],
      preservedThreadIds: ReadonlySet<ThreadId>,
    ) => {
      if (queryKey[0] !== orchestrationQueryKeys.all[0]) {
        return false;
      }
      const scopedThreadId = queryKey[2];
      return (
        typeof scopedThreadId === "string" && preservedThreadIds.has(scopedThreadId as ThreadId)
      );
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
      latestSequence = event.sequence;
      committedSequence = Math.max(committedSequence, event.sequence);
      flushSequenceCommitWaiters();
      if (event.type === "thread.created") {
        clearPromotedDraftThreads(new Set(useStore.getState().threads.map((thread) => thread.id)));
      }
      if (event.type === "project.deleted") {
        pruneDraftThreadsForCurrentProjects();
        removeOrphanedTerminalsForCurrentStoreThreads();
      }
      if (event.type === "thread.deleted") {
        removeOrphanedTerminalsForCurrentStoreThreads();
      }
      if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
        invalidateProviderAndProjectQueries();
      }
    };

    // Live event coalescing. The server forwards every token delta as its own
    // event; applying each one synchronously triggers a Zustand commit per
    // token, which saturates the main thread and stalls rendering. Instead we
    // push events into a pending buffer and flush them inside a single
    // requestAnimationFrame tick. For the fast path this collapses an N-delta
    // burst into a single React commit; the `syncing` and gap branches below
    // still flush synchronously, so an out-of-order or buffered event can
    // produce its own commit independently.
    let pendingEvents: OrchestrationEvent[] = [];
    let pendingFrame: number | null = null;
    let pendingFlushTimeoutId: number | null = null;
    // Safety cap: rAF is paused while the tab is hidden and the reconcile
    // interval is itself throttled in background tabs, so without a cap the
    // pending buffer would grow unbounded across a long streaming response in
    // a backgrounded tab. Flushing synchronously past this threshold bounds
    // memory pressure at the cost of an extra commit.
    const MAX_PENDING_EVENTS = 256;
    const EVENT_BATCH_FALLBACK_FLUSH_MS = 100;

    const applyPendingBatch = () => {
      if (pendingEvents.length === 0) {
        return;
      }
      const batch = pendingEvents;
      pendingEvents = [];
      try {
        applyDomainEventBatch(batch);
      } catch (error) {
        // If the batch apply throws, we've already drained `pendingEvents`.
        // Put the events back so the next flush (via reconcile, visibility,
        // or cleanup) has a chance to retry, and surface the error.
        pendingEvents = [...batch, ...pendingEvents];
        throw error;
      }
      // Replicate the side-effects guarded by applyEventToStore, but only run
      // each side effect once per flush even if the batch contained multiple
      // matching events. The query-invalidation side effect has moved here
      // from the subscription callback so it observes the post-commit store
      // state rather than racing with the pending frame.
      let sawThreadCreated = false;
      let sawThreadDeleted = false;
      let sawProjectDeleted = false;
      let sawProviderInvalidating = false;
      for (const event of batch) {
        if (event.type === "thread.created") sawThreadCreated = true;
        if (event.type === "thread.deleted") sawThreadDeleted = true;
        if (event.type === "project.deleted") sawProjectDeleted = true;
        if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
          sawProviderInvalidating = true;
        }
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
        removeOrphanedTerminalsForCurrentStoreThreads();
      }
      if (sawProviderInvalidating) {
        invalidateProviderAndProjectQueries();
      }
      if (import.meta.env.DEV && batch.length >= 64) {
        console.info("EventRouter coalesced a large batch", {
          size: batch.length,
          firstSequence: batch[0]?.sequence,
          lastSequence: batch[batch.length - 1]?.sequence,
        });
      }
      committedSequence = Math.max(committedSequence, batch[batch.length - 1]?.sequence ?? 0);
      flushSequenceCommitWaiters();
    };

    const flushPending = () => {
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      if (pendingFlushTimeoutId !== null) {
        window.clearTimeout(pendingFlushTimeoutId);
        pendingFlushTimeoutId = null;
      }
      applyPendingBatch();
    };

    const schedulePendingFlush = () => {
      if (pendingFrame === null) {
        pendingFrame = window.requestAnimationFrame(() => {
          pendingFrame = null;
          if (pendingFlushTimeoutId !== null) {
            window.clearTimeout(pendingFlushTimeoutId);
            pendingFlushTimeoutId = null;
          }
          applyPendingBatch();
        });
      }
      // `requestAnimationFrame` can pause when the tab is hidden or the
      // desktop window is occluded, which leaves short assistant replies
      // stuck in `pendingEvents` until a later reconcile. Back it with a
      // short timeout so small batches still become visible promptly.
      if (pendingFlushTimeoutId === null) {
        pendingFlushTimeoutId = window.setTimeout(() => {
          pendingFlushTimeoutId = null;
          if (pendingFrame !== null) {
            window.cancelAnimationFrame(pendingFrame);
            pendingFrame = null;
          }
          applyPendingBatch();
        }, EVENT_BATCH_FALLBACK_FLUSH_MS);
      }
    };

    const enqueueInOrderEvent = (event: OrchestrationEvent) => {
      pendingEvents.push(event);
      // Advance the "next-expected" cursor immediately so the gap check in
      // the domain-event subscriber keeps working while the rAF is pending.
      // The store's lastAppliedSequence is updated inside applyDomainEventBatch.
      latestSequence = event.sequence;
      if (pendingEvents.length >= MAX_PENDING_EVENTS) {
        flushPending();
        return;
      }
      schedulePendingFlush();
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

    const clearSnapshotRetry = () => {
      if (snapshotRetryTimeoutId !== null) {
        window.clearTimeout(snapshotRetryTimeoutId);
        snapshotRetryTimeoutId = null;
      }
      snapshotRetryAttempt = 0;
    };

    const scheduleSnapshotRetry = () => {
      if (disposed || snapshotRetryTimeoutId !== null) {
        return;
      }
      const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(snapshotRetryAttempt, 5));
      snapshotRetryAttempt += 1;
      snapshotRetryTimeoutId = window.setTimeout(() => {
        snapshotRetryTimeoutId = null;
        void syncSnapshot();
      }, delayMs);
    };

    const bufferEvent = (event: OrchestrationEvent) => {
      if (event.sequence <= latestSequence) {
        return;
      }
      bufferedEvents.push(event);
    };

    const drainBufferedEvents = (): boolean => {
      const bufferedBySequence = new Map<number, OrchestrationEvent>();
      for (const event of bufferedEvents) {
        if (event.sequence > latestSequence) {
          bufferedBySequence.set(event.sequence, event);
        }
      }
      const nextEvents = Array.from(bufferedBySequence.values()).toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      bufferedEvents = [];
      for (const event of nextEvents) {
        if (event.sequence <= latestSequence) {
          continue;
        }
        if (event.sequence !== latestSequence + 1) {
          bufferedEvents = nextEvents.filter((entry) => entry.sequence > latestSequence);
          return false;
        }
        applyEventToStore(event);
      }
      return true;
    };

    const resolveCurrentVisibleThreadDetailId = (fallbackThreadId?: ThreadId | null) =>
      resolveVisibleThreadDetailId({
        routeMatch: visibleRouteMatchRef.current,
        ...(fallbackThreadId !== undefined ? { fallbackThreadId } : {}),
        codeReviewWorkflows: useStore.getState().codeReviewWorkflows,
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
              ? Math.round(performance.now() - latestWelcomeReceivedAtMs)
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

    const flushSnapshotSync = async (): Promise<void> => {
      // Belt-and-suspenders: also flush before we read/merge a snapshot in
      // case this is called from a code path that bypasses syncSnapshot.
      flushPending();
      const pendingBootstrapThreadId =
        pathnameRef.current === "/"
          ? (pendingWelcomeRecovery?.payload.bootstrapThreadId ?? null)
          : null;
      const startupDetailThreadId = resolveStartupDetailThreadId({
        routeMatch: visibleRouteMatchRef.current,
        fallbackThreadId: pendingBootstrapThreadId,
      });
      const startupResult = await api.orchestration.getStartupSnapshot(
        startupDetailThreadId ? { detailThreadId: startupDetailThreadId } : undefined,
      );
      if (disposed) return;
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
      });
      if (pendingWelcomeRecovery !== null) {
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
      latestSequence = Math.max(latestSequence, snapshot.snapshotSequence);
      committedSequence = Math.max(committedSequence, snapshot.snapshotSequence);
      flushSequenceCommitWaiters();
      syncStartupSnapshot(snapshot);
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
          durationMs: Math.round(performance.now() - latestWelcomeReceivedAtMs),
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
      const bufferedVisibleThreadId = visibleThreadIdForSnapshot;
      if (!drainBufferedEvents()) {
        pendingSnapshot = true;
        scheduleSnapshotRetry();
        return;
      }
      if (snapshotIsProvisional) {
        scheduleSnapshotRetry();
      } else {
        clearSnapshotRetry();
      }
      const recoveredBootstrapThreadId = await completeWelcomeRecovery();
      const onboardingLiteState = deriveOnboardingLiteState({
        settings: appSettingsRef.current,
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
    };

    const syncSnapshot = async () => {
      if (syncing) {
        pendingSnapshot = true;
        return;
      }
      // Before taking a snapshot we must commit any queued live events so the
      // snapshot merge sees the latest locally-applied sequence.
      flushPending();
      syncing = true;
      pendingSnapshot = false;
      try {
        await flushSnapshotSync();
      } catch {
        scheduleSnapshotRetry();
      } finally {
        syncing = false;
        if (pendingSnapshot && !disposed && snapshotRetryTimeoutId === null) {
          pendingSnapshot = false;
          void syncSnapshot();
        }
      }
    };

    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      if (event.sequence <= latestSequence) {
        return;
      }
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
      // Provider / project query invalidation used to fire here, but the
      // event hadn't yet been applied to the store. It now runs inside
      // applyPendingBatch (live path) and applyEventToStore (buffer-drain
      // path), so the refetch always observes the post-apply state.
      if (syncing) {
        // Buffered events are replayed through drainBufferedEvents which uses
        // the per-event applyEventToStore; flush any pending batch first so
        // sequences line up.
        flushPending();
        bufferEvent(event);
        return;
      }
      if (event.sequence !== latestSequence + 1) {
        flushPending();
        bufferEvent(event);
        pendingSnapshot = true;
        clearSnapshotRetry();
        void syncSnapshot();
        return;
      }
      enqueueInOrderEvent(event);
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      applyTerminalEvent(event);
    });
    const unsubWelcome = onServerWelcome((payload) => {
      pendingWelcomeRecovery = { id: ++nextWelcomeRecoveryId, payload };
      pendingCommandExecutionDetailInvalidation = true;
      latestWelcomeReceivedAtMs = performance.now();
      clearSnapshotRetry();
      void syncSnapshot();
    });
    const reconcileIntervalId = window.setInterval(() => {
      flushPending();
      if (!syncing && snapshotRetryTimeoutId === null) {
        void syncSnapshot();
      }
    }, 60_000);
    // rAF does not run while the tab is hidden, so token deltas arriving in
    // the background accumulate in `pendingEvents`. On foregrounding we
    // immediately apply whatever queued up so the first paint shows current
    // state. (The MAX_PENDING_EVENTS cap still bounds memory growth while
    // hidden.)
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        flushPending();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    // onServerConfigUpdated replays the latest cached value synchronously
    // during subscribe. Skip the toast for that replay so effect re-runs
    // don't produce duplicate toasts.
    let subscribed = false;
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      if (!subscribed) return;
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
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    subscribed = true;
    const unsubMcpStatusUpdated = onMcpStatusUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
    });
    const unsubGitStatusInvalidated = api.git.onStatusInvalidated((payload) => {
      void invalidateGitQueries(queryClient, { cwd: payload.cwd });
    });
    return () => {
      disposed = true;
      rejectSequenceCommitWaiters(makeAbortError());
      // Apply anything still queued so tokens that arrived right before
      // teardown aren't lost.
      flushPending();
      clearSnapshotRetry();
      abortActiveDetailPrefetches();
      window.clearInterval(reconcileIntervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
      unsubMcpStatusUpdated();
      unsubGitStatusInvalidated();
    };
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
