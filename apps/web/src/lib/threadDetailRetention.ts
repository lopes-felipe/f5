import type { ThreadId } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { useNextTurnQueueStore } from "../nextTurnQueueStore";
import { type AppState, useStore } from "../store";
import type { Thread } from "../types";
import { orchestrationQueryKeys } from "./orchestrationReactQuery";
import { isThreadRunning } from "./threadRunning";

/**
 * Bounds the thread detail bodies (messages, command executions, turn diffs)
 * kept in memory. Inactive hydrated threads form an LRU; the least recently
 * used are evicted once more than `maxThreads` are hydrated or their estimated
 * size exceeds `maxBytes`. Evicted threads rehydrate from the tail RPC when
 * opened, exactly like threads that were never loaded.
 */
export const THREAD_DETAIL_RETENTION_MAX_THREADS = 10;
export const THREAD_DETAIL_RETENTION_MAX_BYTES = 32 * 1024 * 1024;
/** Coalesces streaming bursts; retention only needs to converge, not be exact. */
const THREAD_DETAIL_RETENTION_DEBOUNCE_MS = 1_000;

export interface ThreadDetailRetentionLimits {
  readonly maxThreads: number;
  readonly maxBytes: number;
}

const DEFAULT_LIMITS: ThreadDetailRetentionLimits = {
  maxThreads: THREAD_DETAIL_RETENTION_MAX_THREADS,
  maxBytes: THREAD_DETAIL_RETENTION_MAX_BYTES,
};

// ── Visible threads and recency ──────────────────────────────────────

const retainCountByThreadId = new Map<ThreadId, number>();
const lastUsedAtByThreadId = new Map<ThreadId, number>();
let usageClock = 0;

function touchThread(threadId: ThreadId): void {
  usageClock += 1;
  lastUsedAtByThreadId.set(threadId, usageClock);
}

/**
 * Pins a thread's details while a surface shows them. Returns the release
 * function; releasing marks the thread most recently used.
 */
export function retainThreadDetail(threadId: ThreadId): () => void {
  retainCountByThreadId.set(threadId, (retainCountByThreadId.get(threadId) ?? 0) + 1);
  touchThread(threadId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (retainCountByThreadId.get(threadId) ?? 1) - 1;
    if (count <= 0) {
      retainCountByThreadId.delete(threadId);
    } else {
      retainCountByThreadId.set(threadId, count);
    }
    touchThread(threadId);
  };
}

// ── Size estimate ────────────────────────────────────────────────────

const estimatedBytesByObject = new WeakMap<object, number>();

/** UTF-16 size of the JSON form, cached per (immutable) object. */
function estimateObjectBytes(value: object): number {
  const cached = estimatedBytesByObject.get(value);
  if (cached !== undefined) return cached;
  let bytes: number;
  try {
    bytes = (JSON.stringify(value)?.length ?? 0) * 2;
  } catch {
    bytes = 1_024;
  }
  estimatedBytesByObject.set(value, bytes);
  return bytes;
}

function estimateListBytes(items: ReadonlyArray<object>): number {
  let bytes = 0;
  for (const item of items) bytes += estimateObjectBytes(item);
  return bytes;
}

/** Estimated size of the detail bodies eviction would drop. */
export function estimateThreadDetailBytes(
  thread: Pick<Thread, "messages" | "commandExecutions" | "turnDiffSummaries"> &
    Partial<Pick<Thread, "tasks" | "tasksTracking" | "sessionNotes" | "history">>,
): number {
  return (
    estimateListBytes(thread.messages) +
    estimateListBytes(thread.commandExecutions) +
    estimateListBytes(thread.turnDiffSummaries) +
    estimateListBytes(thread.tasks ?? []) +
    (thread.tasksTracking ? estimateObjectBytes(thread.tasksTracking) : 0) +
    (thread.sessionNotes ? estimateObjectBytes(thread.sessionNotes) : 0) +
    (thread.history ? estimateObjectBytes(thread.history) : 0)
  );
}

// ── Eviction selection ───────────────────────────────────────────────

export interface ThreadDetailRetentionInput {
  readonly threads: ReadonlyArray<Thread>;
  /** Threads that must stay hydrated (visible, loading, unresolved state). */
  readonly pinnedThreadIds: ReadonlySet<ThreadId>;
  /** Higher is more recent; threads without an entry are least recent. */
  readonly lastUsedAtByThreadId: ReadonlyMap<ThreadId, number>;
  readonly limits?: ThreadDetailRetentionLimits;
  readonly estimateBytes?: (thread: Thread) => number;
}

export interface ThreadDetailRetentionPlan {
  readonly evictThreadIds: ThreadId[];
  readonly pinnedBytes: number;
}

/** Least recently used unpinned threads to evict until both limits hold. */
export function planThreadDetailRetention(
  input: ThreadDetailRetentionInput,
): ThreadDetailRetentionPlan {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const estimateBytes = input.estimateBytes ?? estimateThreadDetailBytes;
  let hydratedCount = 0;
  let totalBytes = 0;
  let pinnedBytes = 0;
  const evictable: Array<{ thread: Thread; bytes: number; lastUsedAt: number }> = [];
  for (const thread of input.threads) {
    if (!thread.detailsLoaded) continue;
    const bytes = estimateBytes(thread);
    hydratedCount += 1;
    totalBytes += bytes;
    if (input.pinnedThreadIds.has(thread.id)) {
      pinnedBytes += bytes;
    } else {
      evictable.push({
        thread,
        bytes,
        lastUsedAt: input.lastUsedAtByThreadId.get(thread.id) ?? 0,
      });
    }
  }

  evictable.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const evictThreadIds: ThreadId[] = [];
  for (const candidate of evictable) {
    if (hydratedCount <= limits.maxThreads && totalBytes <= limits.maxBytes) break;
    evictThreadIds.push(candidate.thread.id);
    hydratedCount -= 1;
    totalBytes -= candidate.bytes;
  }
  return { evictThreadIds, pinnedBytes };
}

/**
 * Visible threads, threads whose detail load is in flight, threads with a
 * running turn (they would be re-warmed by the next live event) and threads
 * with unresolved optimistic queued sends.
 */
function collectPinnedThreadIds(state: AppState): Set<ThreadId> {
  const pinned = new Set<ThreadId>(retainCountByThreadId.keys());
  for (const threadId of state.detailEventBufferByThreadId.keys()) pinned.add(threadId);
  for (const thread of state.threads) {
    if (thread.detailsLoaded && isThreadRunning(thread)) pinned.add(thread.id);
  }
  const queueByThreadId = useNextTurnQueueStore.getState().byThreadId;
  for (const [threadId, queue] of Object.entries(queueByThreadId)) {
    if (queue && queue.optimistic.length > 0) pinned.add(threadId as ThreadId);
  }
  return pinned;
}

let pinnedOverBudget = false;

/**
 * True when the last retention pass found pinned threads alone over the byte
 * budget; prefetch stops then, since anything warmed would be evicted again.
 */
export function isThreadDetailPrefetchOverBudget(): boolean {
  return pinnedOverBudget;
}

/** Applies one retention pass to the store and the thread-scoped query cache. */
export function enforceThreadDetailRetention(
  queryClient: QueryClient,
  limits: ThreadDetailRetentionLimits = DEFAULT_LIMITS,
): ThreadId[] {
  const state = useStore.getState();
  for (const thread of state.threads) {
    // Hydrated without being shown (prefetch, live warm): recent as of now.
    if (thread.detailsLoaded && !lastUsedAtByThreadId.has(thread.id)) touchThread(thread.id);
  }
  const plan = planThreadDetailRetention({
    threads: state.threads,
    pinnedThreadIds: collectPinnedThreadIds(state),
    lastUsedAtByThreadId,
    limits,
    estimateBytes: (thread) => {
      const coverage = state.detailCoverageByThreadId?.get(thread.id);
      const coverageBytes = coverage
        ? 64 + [...coverage.entities.keys()].reduce((sum, key) => sum + key.length * 2 + 16, 0)
        : 0;
      return estimateThreadDetailBytes(thread) + coverageBytes;
    },
  });
  pinnedOverBudget = plan.pinnedBytes > limits.maxBytes;
  if (plan.evictThreadIds.length === 0) return [];

  const evicted = new Set<string>(plan.evictThreadIds);
  for (const threadId of plan.evictThreadIds) lastUsedAtByThreadId.delete(threadId);
  state.evictThreadDetails(plan.evictThreadIds);
  // Cached tails would be stale on reopen: unloaded threads skip detail events.
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === orchestrationQueryKeys.all[0] &&
      typeof query.queryKey[2] === "string" &&
      evicted.has(query.queryKey[2]),
  });
  return plan.evictThreadIds;
}

/**
 * Runs retention whenever the set of hydrated threads may have grown, coalesced
 * so streaming updates do not re-run it per delta. Returns the stop function.
 */
export function startThreadDetailRetention(queryClient: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      enforceThreadDetailRetention(queryClient);
    }, THREAD_DETAIL_RETENTION_DEBOUNCE_MS);
  };
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.threads !== previous.threads) schedule();
  });
  schedule();
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}

export function resetThreadDetailRetentionForTests(): void {
  retainCountByThreadId.clear();
  lastUsedAtByThreadId.clear();
  usageClock = 0;
  pinnedOverBudget = false;
}
