import type { ClientDiagnosticsCounters, OrchestrationEvent, ThreadId } from "@t3tools/contracts";

export interface EventRouterScheduler {
  readonly raf: (callback: () => void) => number;
  readonly cancelRaf: (id: number) => void;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly queueMicrotask: (callback: () => void) => void;
}

/** Snapshot preparation/merging stays in the application wiring. No DOM or store globals. */
export interface RouterSnapshot {
  readonly sequence: number;
  readonly provisional: boolean;
  readonly merge: () => void;
  readonly finish: () => Promise<void>;
}

export interface OrchestrationEventRouterDeps {
  readonly api: { readonly readSnapshot: () => Promise<RouterSnapshot> };
  readonly actions: {
    readonly applyBatch: (events: readonly OrchestrationEvent[]) => void;
    readonly applyEvent: (event: OrchestrationEvent) => void;
    readonly onGap: () => void;
    readonly onResynchronizing: () => void;
    readonly onSynchronized: () => void;
    readonly onRecoveryError: (message: string) => void;
    readonly repairThreads: (threadIds: ReadonlySet<ThreadId>) => void;
    readonly logPoison: (batch: readonly OrchestrationEvent[], error: unknown) => void;
  };
  readonly scheduler: EventRouterScheduler;
  readonly now: () => number;
}

const abortError = () =>
  Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

export function createOrchestrationEventRouter(deps: OrchestrationEventRouterDeps) {
  const { scheduler, actions } = deps;
  let disposed = false;
  let latestSequence = 0;
  let committedSequence = 0;
  let syncing = false;
  let pendingSnapshot = false;
  let snapshotGeneration = 0;
  let snapshotInvalidated = false;
  let immediateRecovery = false;
  let retryAttempt = 0;
  let retryTimer: number | null = null;
  let recoveryScheduled = false;
  let recoveryTicket = 0;
  let breakerOpen = false;
  let poisonBatches = 0;
  const counters = {
    snapshotSyncs: 0,
    gapRecoveries: 0,
    bufferOverflows: 0,
    poisonBatches: 0,
    connectedMs: 0,
  } satisfies ClientDiagnosticsCounters;
  const applyBatchBuckets = Array<number>(9).fill(0);
  const applyBatchBounds = [1, 2, 4, 8, 16, 32, 64, 128, Infinity];
  const timedApply = (apply: () => void) => {
    const started = deps.now();
    try {
      apply();
    } finally {
      const elapsed = Math.max(0, deps.now() - started);
      applyBatchBuckets[applyBatchBounds.findIndex((upper) => elapsed <= upper)]!++;
    }
  };
  let poisonTimes: number[] = [];
  const poisonedThreadIds = new Set<ThreadId>();
  let pendingEvents: OrchestrationEvent[] = [];
  let pendingFrame: number | null = null;
  let pendingTimer: number | null = null;
  let bufferedEvents: OrchestrationEvent[] = [];
  let bufferedBytes = 0;
  const waiters = new Set<{
    target: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();

  const flushWaiters = () => {
    for (const waiter of waiters) if (committedSequence >= waiter.target) waiter.resolve();
  };
  const clearSnapshotRetry = () => {
    if (retryTimer !== null) scheduler.clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
  };
  const scheduleSnapshotRetry = () => {
    if (disposed || breakerOpen || retryTimer !== null) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt++, 5));
    retryTimer = scheduler.setTimeout(() => {
      retryTimer = null;
      if (!disposed) void syncSnapshot();
    }, delay);
  };
  const enterRecovery = () => {
    if (disposed || breakerOpen || recoveryScheduled) return;
    recoveryScheduled = true;
    const ticket = ++recoveryTicket;
    scheduler.queueMicrotask(() => {
      if (ticket !== recoveryTicket) return;
      recoveryScheduled = false;
      if (!disposed && !breakerOpen) void syncSnapshot();
    });
  };
  const poison = (batch: readonly OrchestrationEvent[], error: unknown) => {
    latestSequence = committedSequence;
    immediateRecovery = true;
    snapshotInvalidated = true;
    snapshotGeneration++;
    bufferedEvents = [];
    bufferedBytes = 0;
    pendingSnapshot = true;
    poisonBatches++;
    counters.poisonBatches++;
    for (const event of batch) {
      if (event.aggregateKind === "thread") poisonedThreadIds.add(event.aggregateId as ThreadId);
    }
    actions.logPoison(batch, error);
    actions.onResynchronizing();
    const now = deps.now();
    poisonTimes = [...poisonTimes.filter((time) => now - time < 60_000), now];
    if (poisonTimes.length >= 3) {
      breakerOpen = true;
      clearSnapshotRetry();
      actions.onRecoveryError("Synchronization failed repeatedly. Reload the app to recover.");
      for (const waiter of waiters) waiter.reject(new Error("Synchronization requires reload."));
    } else enterRecovery();
  };
  const applyPendingBatch = () => {
    if (disposed || breakerOpen || pendingEvents.length === 0) return;
    const batch = pendingEvents;
    pendingEvents = [];
    try {
      timedApply(() => actions.applyBatch(batch));
      committedSequence = Math.max(committedSequence, batch.at(-1)!.sequence);
      flushWaiters();
    } catch (error) {
      // Never requeue poison: snapshots must be able to get past this batch.
      poison(batch, error);
    }
  };
  const cancelPendingFlush = () => {
    if (pendingFrame !== null) scheduler.cancelRaf(pendingFrame);
    if (pendingTimer !== null) scheduler.clearTimeout(pendingTimer);
    pendingFrame = pendingTimer = null;
  };
  const flushPending = () => {
    cancelPendingFlush();
    applyPendingBatch();
  };
  const schedulePendingFlush = () => {
    if (pendingFrame === null) pendingFrame = scheduler.raf(flushPending);
    // rAF pauses in hidden tabs. A timeout also bounds short background replies.
    if (pendingTimer === null) pendingTimer = scheduler.setTimeout(flushPending, 100);
  };
  const enqueueInOrderEvent = (event: OrchestrationEvent) => {
    pendingEvents.push(event);
    latestSequence = event.sequence;
    if (pendingEvents.length >= 256) flushPending();
    else schedulePendingFlush();
  };
  const bufferEvent = (event: OrchestrationEvent) => {
    if (event.sequence <= latestSequence || snapshotInvalidated) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (bufferedEvents.length >= 2_000 || bufferedBytes + bytes > 32 * 1024 * 1024) {
      counters.bufferOverflows++;
      snapshotInvalidated = true;
      snapshotGeneration++;
      bufferedEvents = [];
      bufferedBytes = 0;
      pendingSnapshot = true;
      actions.onResynchronizing();
      return;
    }
    bufferedEvents.push(event);
    bufferedBytes += bytes;
  };
  const drainBufferedEvents = () => {
    const events = [
      ...new Map(bufferedEvents.map((event) => [event.sequence, event])).values(),
    ].sort((a, b) => a.sequence - b.sequence);
    bufferedEvents = [];
    bufferedBytes = 0;
    for (const event of events) {
      if (event.sequence <= latestSequence) continue;
      if (event.sequence !== latestSequence + 1) {
        for (const remaining of events) bufferEvent(remaining);
        return false;
      }
      try {
        timedApply(() => actions.applyEvent(event));
        latestSequence = committedSequence = event.sequence;
        flushWaiters();
      } catch (error) {
        poison([event], error);
        return false;
      }
    }
    return true;
  };
  const flushSnapshotSync = async () => {
    flushPending();
    if (breakerOpen || disposed) return;
    const generation = snapshotGeneration;
    counters.snapshotSyncs++;
    const snapshot = await deps.api.readSnapshot();
    if (disposed || breakerOpen) return;
    if (generation !== snapshotGeneration)
      throw new Error("Snapshot recovery was invalidated; refetch required.");
    snapshot.merge();
    latestSequence = Math.max(latestSequence, snapshot.sequence);
    committedSequence = Math.max(committedSequence, snapshot.sequence);
    flushWaiters();
    if (!drainBufferedEvents()) {
      pendingSnapshot = true;
      if (!snapshotInvalidated) scheduleSnapshotRetry();
      return;
    }
    await snapshot.finish();
    if (disposed || breakerOpen) return;
    if (generation !== snapshotGeneration)
      throw new Error("Snapshot recovery was invalidated during finalization.");
    // Hydration/welcome finalization is asynchronous; pushes received meanwhile
    // still belong to this synchronization cycle. Drain before announcing it.
    if (!drainBufferedEvents()) {
      pendingSnapshot = true;
      if (!snapshotInvalidated) scheduleSnapshotRetry();
      return;
    }
    if (snapshot.provisional) scheduleSnapshotRetry();
    else {
      clearSnapshotRetry();
      actions.onSynchronized();
    }
    if (!disposed && !breakerOpen && poisonedThreadIds.size > 0) {
      actions.repairThreads(new Set(poisonedThreadIds));
      poisonedThreadIds.clear();
    }
  };
  const syncSnapshot = async (): Promise<void> => {
    if (disposed || breakerOpen) return;
    if (syncing) {
      pendingSnapshot = true;
      return;
    }
    flushPending();
    if (breakerOpen) return;
    // An explicit welcome/reconcile sync also satisfies queued poison recovery.
    recoveryScheduled = false;
    recoveryTicket++;
    syncing = true;
    actions.onResynchronizing();
    snapshotInvalidated = false;
    immediateRecovery = false;
    pendingSnapshot = false;
    try {
      await flushSnapshotSync();
    } catch {
      // Poison invalidation requires a fresh snapshot immediately. Ordinary
      // network/merge failures retain the bounded retry backoff.
      if (snapshotInvalidated && immediateRecovery) clearSnapshotRetry();
      else scheduleSnapshotRetry();
    } finally {
      syncing = false;
      if (pendingSnapshot && !disposed && !breakerOpen && retryTimer === null) {
        pendingSnapshot = false;
        enterRecovery();
      }
    }
  };
  return {
    getDiagnostics: () => ({
      counters: { ...counters },
      applyBatchBuckets: [...applyBatchBuckets],
    }),
    get latestSequence() {
      return latestSequence;
    },
    get committedSequence() {
      return committedSequence;
    },
    get syncing() {
      return syncing;
    },
    get hasSnapshotRetry() {
      return retryTimer !== null;
    },
    get poisonBatches() {
      return poisonBatches;
    },
    get breakerOpen() {
      return breakerOpen;
    },
    flushPending,
    syncSnapshot,
    clearSnapshotRetry,
    resetStream() {
      cancelPendingFlush();
      clearSnapshotRetry();
      snapshotGeneration++;
      immediateRecovery = true;
      snapshotInvalidated = true;
      pendingSnapshot = true;
      latestSequence = committedSequence = 0;
      pendingEvents = bufferedEvents = [];
      bufferedBytes = 0;
      for (const waiter of waiters) waiter.reject(abortError());
    },
    invalidateSnapshot() {
      snapshotGeneration++;
      snapshotInvalidated = true;
      immediateRecovery = true;
      pendingSnapshot = true;
      clearSnapshotRetry();
    },
    receive(event: OrchestrationEvent) {
      if (disposed || breakerOpen || event.sequence <= latestSequence) return;
      if (syncing || snapshotInvalidated) {
        flushPending();
        bufferEvent(event);
        return;
      }
      if (event.sequence !== latestSequence + 1) {
        flushPending();
        bufferEvent(event);
        counters.gapRecoveries++;
        actions.onGap();
        clearSnapshotRetry();
        void syncSnapshot();
      } else enqueueInOrderEvent(event);
    },
    waitForCommittedSequence(target: number, signal?: AbortSignal): Promise<void> {
      if (disposed || signal?.aborted) return Promise.reject(abortError());
      if (breakerOpen) return Promise.reject(new Error("Synchronization requires reload."));
      if (committedSequence >= target) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          waiters.delete(waiter);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        const waiter = {
          target,
          resolve: () => {
            cleanup();
            resolve();
          },
          reject: (error: unknown) => {
            cleanup();
            reject(error);
          },
        };
        waiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    dispose() {
      if (disposed) return;
      // Commit any last accepted output before preventing all future callbacks.
      flushPending();
      disposed = true;
      cancelPendingFlush();
      clearSnapshotRetry();
      for (const waiter of waiters) waiter.reject(abortError());
      pendingEvents = bufferedEvents = [];
      bufferedBytes = 0;
      poisonedThreadIds.clear();
    },
  };
}
