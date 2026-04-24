import type {
  OrchestrationEvent,
  OrchestrationThreadTailDetails,
  ThreadId,
} from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";

import {
  fetchAndSyncThreadDetail,
  scheduleThreadDetailRefreshIfProvisional,
  warmThreadFileChanges,
} from "./orchestrationReactQuery";
import { getVisibleThreads, sortThreadsByActivity } from "./threadOrdering";
import { useStore } from "../store";

export interface ThreadWarmProfile {
  includeFileChanges: boolean;
}

const DEFAULT_THREAD_WARM_PROFILE: ThreadWarmProfile = {
  includeFileChanges: false,
};

/**
 * Number of most-recent threads (across all projects) whose detail payloads are
 * warmed into the cache after the app finishes its startup snapshot.
 *
 * Sized to cover the typical sidebar viewport (5–7 threads) plus a little
 * scroll room, while still bounding memory and network usage. Includes the
 * visible and welcome-bootstrap threads that are force-prefetched before the
 * preload runs — see `preloadRecentThreadDetails` callers.
 */
export const RECENT_THREAD_PRELOAD_COUNT = 10;

/**
 * Max in-flight thread bundle warmth passes. Each worker fetches thread
 * details first, then optionally file changes, keeping the startup fan-out
 * bounded to a small, predictable pool.
 */
export const RECENT_THREAD_PRELOAD_CONCURRENCY = 3;
export const LIVE_THREAD_WARM_CONCURRENCY = 3;
// Wait just past EventRouter's 100ms fallback batch flush before starting a
// background tail fetch. This lets the triggering live event usually commit
// first without holding the warm forever if routing stalls.
const LIVE_THREAD_WARM_COMMIT_WAIT_TIMEOUT_MS = 120;

// Background live warms intentionally skip file-change hydration. They exist
// to unblock unloaded streaming threads with bounded fan-out, not to fully
// mirror the heavier visible-thread preload path.
const LIVE_THREAD_WARM_PROFILE: ThreadWarmProfile = {
  includeFileChanges: false,
};

interface LiveThreadWarmTask {
  readonly threadId: ThreadId;
  readonly waitForSequenceInclusive: number;
  readonly queryClient: QueryClient;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly waitUntilSequenceCommitted?: (
    sequenceInclusive: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly warmProfile: ThreadWarmProfile;
  started: boolean;
}

const liveThreadWarmTasksByThreadId = new Map<ThreadId, LiveThreadWarmTask>();
const pendingLiveThreadWarmTasks: LiveThreadWarmTask[] = [];
let activeLiveThreadWarmCount = 0;

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, delayMs);
    });
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForLiveWarmCommit(task: LiveThreadWarmTask): Promise<void> {
  if (!task.waitUntilSequenceCommitted) {
    return;
  }

  await Promise.race([
    task.waitUntilSequenceCommitted(task.waitForSequenceInclusive, task.signal),
    waitForDelay(LIVE_THREAD_WARM_COMMIT_WAIT_TIMEOUT_MS, task.signal),
  ]);
  if (task.signal?.aborted) {
    throw makeAbortError();
  }
}

export function getLiveThreadWarmThreadIdForDomainEvent(
  event: OrchestrationEvent,
): ThreadId | null {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.reverted":
    case "thread.turn-diff-completed":
    case "thread.tasks.updated":
    case "thread.session-notes-recorded":
      return event.payload.threadId;
    default:
      return null;
  }
}

function pumpLiveThreadWarmQueue() {
  while (
    activeLiveThreadWarmCount < LIVE_THREAD_WARM_CONCURRENCY &&
    pendingLiveThreadWarmTasks.length > 0
  ) {
    const nextTask = pendingLiveThreadWarmTasks.shift();
    if (!nextTask) {
      return;
    }

    nextTask.started = true;
    activeLiveThreadWarmCount += 1;
    void (async () => {
      try {
        await waitForLiveWarmCommit(nextTask);
        await warmThreadBundle(nextTask.queryClient, nextTask.threadId, {
          ...(nextTask.signal ? { signal: nextTask.signal } : {}),
          captureLiveEvents: false,
          warmProfile: nextTask.warmProfile,
        });
        nextTask.resolve();
      } catch (error) {
        nextTask.reject(error);
      } finally {
        useStore.getState().clearThreadDetailBuffer(nextTask.threadId);
        activeLiveThreadWarmCount -= 1;
        // A canceled task can be replaced by a new task for the same thread
        // before the old one finishes aborting. Only clear the map slot if it
        // still points at this exact task instance.
        if (liveThreadWarmTasksByThreadId.get(nextTask.threadId) === nextTask) {
          liveThreadWarmTasksByThreadId.delete(nextTask.threadId);
        }
        pumpLiveThreadWarmQueue();
      }
    })();
  }
}

/**
 * Synchronously creates the per-thread live-event buffer before the caller
 * reduces the same event, then queues a bounded background detail warm.
 */
export function scheduleLiveThreadWarmForDomainEvent(
  queryClient: QueryClient,
  event: OrchestrationEvent,
  options?: {
    signal?: AbortSignal;
    waitUntilSequenceCommitted?: (sequenceInclusive: number, signal?: AbortSignal) => Promise<void>;
    warmProfile?: ThreadWarmProfile;
  },
): Promise<void> | null {
  const threadId = getLiveThreadWarmThreadIdForDomainEvent(event);
  if (!threadId) {
    return null;
  }

  const currentState = useStore.getState();
  const thread = currentState.threads.find((entry) => entry.id === threadId);
  if (!thread || thread.detailsLoaded) {
    return null;
  }

  const existingTask = liveThreadWarmTasksByThreadId.get(threadId);
  if (existingTask) {
    return existingTask.promise;
  }

  if (currentState.detailEventBufferByThreadId.has(threadId)) {
    return null;
  }

  currentState.beginThreadDetailLoad(threadId);

  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const task: LiveThreadWarmTask = {
    threadId,
    waitForSequenceInclusive: event.sequence,
    queryClient,
    promise,
    resolve,
    reject,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.waitUntilSequenceCommitted
      ? { waitUntilSequenceCommitted: options.waitUntilSequenceCommitted }
      : {}),
    warmProfile: options?.warmProfile ?? LIVE_THREAD_WARM_PROFILE,
    started: false,
  };
  liveThreadWarmTasksByThreadId.set(threadId, task);
  pendingLiveThreadWarmTasks.push(task);
  pumpLiveThreadWarmQueue();
  return promise;
}

export function cancelLiveThreadWarmScheduler(error?: unknown): void {
  const reason = error ?? makeAbortError();
  const scheduledTasks = Array.from(liveThreadWarmTasksByThreadId.values());
  liveThreadWarmTasksByThreadId.clear();
  pendingLiveThreadWarmTasks.length = 0;

  for (const task of scheduledTasks) {
    if (task.started) {
      // In-flight tasks are aborted by the caller's signal. Keep their buffer
      // retained until that async path reaches its own finally block.
      continue;
    }
    useStore.getState().clearThreadDetailBuffer(task.threadId);
    task.reject(reason);
  }
}

export function resetLiveThreadWarmSchedulerForTests(): void {
  cancelLiveThreadWarmScheduler(makeAbortError());
}

/**
 * Warm one thread's bundle into cache/store in a bounded sequence:
 * details, provisional detail refresh scheduling, then file-change summaries.
 * Auxiliary collections honor `warmProfile`.
 */
export async function warmThreadBundle(
  queryClient: QueryClient,
  threadId: ThreadId,
  options?: {
    forceThreadDetails?: boolean;
    signal?: AbortSignal;
    captureLiveEvents?: boolean;
    initialDetails?: OrchestrationThreadTailDetails | null;
    warmProfile?: ThreadWarmProfile;
  },
): Promise<void> {
  const warmProfile = options?.warmProfile ?? DEFAULT_THREAD_WARM_PROFILE;

  let details = options?.initialDetails;
  if (!details) {
    details = await fetchAndSyncThreadDetail(queryClient, threadId, {
      ...(options?.forceThreadDetails !== undefined ? { force: options.forceThreadDetails } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.captureLiveEvents !== undefined
        ? { captureLiveEvents: options.captureLiveEvents }
        : {}),
    });
  }

  if (options?.signal?.aborted) {
    return;
  }

  if (details) {
    void scheduleThreadDetailRefreshIfProvisional(queryClient, threadId, details, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.captureLiveEvents !== undefined
        ? { captureLiveEvents: options.captureLiveEvents }
        : {}),
    }).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      console.warn("Failed to refresh provisional thread details.", {
        threadId,
        error,
      });
    });
  }

  if (warmProfile.includeFileChanges) {
    await warmThreadFileChanges(
      queryClient,
      threadId,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }
}

/**
 * Fire an async warmth pass for the top-N most recent non-archived threads
 * across all projects, so subsequent navigation renders instantly from cache.
 *
 * Candidate selection reuses the shared activity ordering and archive/workflow
 * visibility rules (`sortThreadsByActivity` + `getVisibleThreads`) so it stays
 * in sync with the sidebar. Threads whose details are already loaded (for
 * example, the currently visible thread already force-prefetched by the
 * startup snapshot handler) are filtered out.
 *
 * Errors on individual threads are logged and swallowed; one failure does not
 * stop the batch.
 */
export async function preloadRecentThreadDetails(
  queryClient: QueryClient,
  options?: {
    limit?: number;
    concurrency?: number;
    signal?: AbortSignal;
    warmProfile?: ThreadWarmProfile;
    /**
     * Threads that the caller has already dispatched (or is about to dispatch)
     * fetches for — e.g. the currently visible thread or welcome-bootstrap
     * thread. Excluded from the candidate list so the helper does not race
     * those force-prefetches or double-count them against `limit`.
     */
    excludeThreadIds?: ReadonlyArray<ThreadId>;
  },
): Promise<void> {
  const limit = options?.limit ?? RECENT_THREAD_PRELOAD_COUNT;
  const concurrency = Math.max(1, options?.concurrency ?? RECENT_THREAD_PRELOAD_CONCURRENCY);
  if (limit <= 0 || options?.signal?.aborted) return;
  const warmProfile = options?.warmProfile ?? DEFAULT_THREAD_WARM_PROFILE;

  const excluded = new Set<ThreadId>(options?.excludeThreadIds ?? []);
  const { threads, planningWorkflows, codeReviewWorkflows } = useStore.getState();
  const candidates = sortThreadsByActivity(
    getVisibleThreads(threads, planningWorkflows, codeReviewWorkflows),
  )
    .filter((thread) => !thread.detailsLoaded && !excluded.has(thread.id))
    .slice(0, limit)
    .map((thread): ThreadId => thread.id);

  if (candidates.length === 0) return;

  let nextIndex = 0;
  const worker = async () => {
    while (!options?.signal?.aborted) {
      const i = nextIndex++;
      if (i >= candidates.length) return;
      const threadId = candidates[i];
      // Defensive: `nextIndex` is bounded above, but TS still narrows
      // `candidates[i]` to `Thread | undefined`. Skip rather than exit so a
      // sparse-array oddity doesn't starve the other workers in the pool.
      if (!threadId) continue;
      try {
        await warmThreadBundle(queryClient, threadId, {
          ...(options?.signal ? { signal: options.signal } : {}),
          captureLiveEvents: false,
          warmProfile,
        });
      } catch (error) {
        console.warn("Failed to preload thread bundle.", { threadId, error });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
}
