import type { ProviderKind, ThreadId } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { type ActivityBucket, bucketActivityAt } from "./lib/activityGrouping";
import { compareThreadsByActivity } from "./lib/threadOrdering";
import { type AppState, useStore } from "./store";
import {
  hasUnseenCompletion,
  resolveThreadStatusForThread,
  type ThreadStatus,
} from "./threadStatus";
import type { Project, Thread, ThreadListItem } from "./types";

export type { ThreadListItem } from "./types";

/**
 * Derived, render-stable views over `AppState.threads`.
 *
 * Streaming replaces the active `Thread` object on every delta, so list
 * surfaces (sidebar, Home, palette, controllers) that subscribe to the whole
 * `threads` array re-render for every token. These selectors are derived
 * outside the store state, so none of the store's write sites can drift, and
 * they hand back the previous object whenever nothing a list renders changed.
 */

export interface ThreadSummary extends ThreadListItem {
  /** Status pill input, from `resolveThreadStatusForThread`. */
  readonly status: ThreadStatus;
  /** A completed turn the user has not seen yet. */
  readonly unread: boolean;
  readonly sessionProvider: ProviderKind | null;
}

const LIST_ITEM_KEYS = [
  "id",
  "projectId",
  "title",
  "titleState",
  "titleSource",
  "titleRevision",
  "titleUpdatedAt",
  "titleRegeneration",
  "model",
  "modelSelection",
  "runtimeMode",
  "interactionMode",
  "codexThreadId",
  "createdAt",
  "archivedAt",
  "settledAt",
  "settledBy",
  "autoSettleDisabled",
  "pinnedAt",
  "pinOrderKey",
  "snoozedUntil",
  "snoozedAt",
  "lastVisitedAt",
  "branch",
  "worktreePath",
  "scratchPath",
  "threadReferences",
  "error",
] as const satisfies ReadonlyArray<Exclude<keyof ThreadListItem, "lastInteractionAt">>;

const SUMMARY_KEYS = [...LIST_ITEM_KEYS, "status", "unread", "sessionProvider"] as const;

type ThreadSummaryCore = Omit<ThreadSummary, "lastInteractionAt">;

// ── Index ────────────────────────────────────────────────────────────

let indexSource: ReadonlyArray<Thread> | null = null;
let indexValue: ReadonlyMap<ThreadId, number> = new Map();

function sameIdSequence(
  threads: ReadonlyArray<Thread>,
  index: ReadonlyMap<ThreadId, number>,
): boolean {
  if (threads.length !== index.size) return false;
  for (let position = 0; position < threads.length; position += 1) {
    if (index.get(threads[position]!.id) !== position) return false;
  }
  return true;
}

/** Thread id → index into `state.threads`, reused while the id sequence is unchanged. */
export function selectThreadIndexById(
  state: Pick<AppState, "threads">,
): ReadonlyMap<ThreadId, number> {
  if (state.threads === indexSource) return indexValue;
  indexSource = state.threads;
  if (!sameIdSequence(state.threads, indexValue)) {
    indexValue = new Map(state.threads.map((thread, position) => [thread.id, position] as const));
  }
  return indexValue;
}

export function selectThreadById(
  state: Pick<AppState, "threads">,
  threadId: ThreadId | null | undefined,
): Thread | undefined {
  if (!threadId) return undefined;
  const position = selectThreadIndexById(state).get(threadId);
  return position === undefined ? undefined : state.threads[position];
}

/**
 * The live `lastInteractionAt` of a thread, read once from the store (for
 * labels built outside render, such as palette items). Falls back to the
 * item's own value for unsaved drafts.
 */
export function liveThreadActivityAt(thread: Pick<Thread, "id" | "lastInteractionAt">): string {
  return (
    selectThreadById(useStore.getState(), thread.id)?.lastInteractionAt ?? thread.lastInteractionAt
  );
}

// ── Summaries ────────────────────────────────────────────────────────

interface StatusMemo {
  readonly activities: Thread["activities"];
  readonly session: Thread["session"];
  readonly latestTurn: Thread["latestTurn"];
  readonly proposedPlans: Thread["proposedPlans"];
  readonly interactionMode: Thread["interactionMode"];
  readonly lastVisitedAt: Thread["lastVisitedAt"];
  readonly status: ThreadStatus;
}

const coreByThread = new WeakMap<Thread, ThreadSummaryCore>();
const previousCoreById = new Map<ThreadId, ThreadSummaryCore>();
const statusMemoById = new Map<ThreadId, StatusMemo>();

function threadStatusOf(thread: Thread): ThreadStatus {
  const memo = statusMemoById.get(thread.id);
  if (
    memo &&
    memo.activities === thread.activities &&
    memo.session === thread.session &&
    memo.latestTurn === thread.latestTurn &&
    memo.proposedPlans === thread.proposedPlans &&
    memo.interactionMode === thread.interactionMode &&
    memo.lastVisitedAt === thread.lastVisitedAt
  ) {
    return memo.status;
  }
  const status = resolveThreadStatusForThread(thread);
  statusMemoById.set(thread.id, {
    activities: thread.activities,
    session: thread.session,
    latestTurn: thread.latestTurn,
    proposedPlans: thread.proposedPlans,
    interactionMode: thread.interactionMode,
    lastVisitedAt: thread.lastVisitedAt,
    status,
  });
  return status;
}

function shallowEqualByKeys<T extends object>(
  left: T,
  right: T,
  keys: ReadonlyArray<keyof T>,
): boolean {
  for (const key of keys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

function summaryCoreOf(thread: Thread): ThreadSummaryCore {
  const cached = coreByThread.get(thread);
  if (cached) return cached;
  // Copy only the keys the thread has, so optional fields stay absent
  // rather than `undefined` (exactOptionalPropertyTypes).
  const listFields: Record<string, unknown> = {};
  for (const key of LIST_ITEM_KEYS) {
    if (key in thread) listFields[key] = thread[key];
  }
  const next = {
    ...(listFields as Omit<ThreadListItem, "lastInteractionAt">),
    status: threadStatusOf(thread),
    unread: hasUnseenCompletion(thread),
    sessionProvider: thread.session?.provider ?? null,
  } satisfies ThreadSummaryCore;
  const previous = previousCoreById.get(thread.id);
  const core =
    previous &&
    shallowEqualByKeys(previous, next, SUMMARY_KEYS as ReadonlyArray<keyof ThreadSummaryCore>)
      ? previous
      : next;
  previousCoreById.set(thread.id, core);
  coreByThread.set(thread, core);
  return core;
}

/** A standalone summary of one thread, with its live activity time (tests, drafts). */
export function toThreadSummary(thread: Thread): ThreadSummary {
  return { ...summaryCoreOf(thread), lastInteractionAt: thread.lastInteractionAt };
}

interface SummaryListCache {
  readonly threads: ReadonlyArray<Thread>;
  readonly summaries: ReadonlyArray<ThreadSummary>;
  readonly summaryById: ReadonlyMap<ThreadId, ThreadSummary>;
  readonly activityOrder: ReadonlyArray<ThreadId>;
}

let summaryList: SummaryListCache = {
  threads: [],
  summaries: [],
  summaryById: new Map(),
  activityOrder: [],
};

/** Whether `order` is still the activity order of `threads` (same members, still sorted). */
function isActivityOrderCurrent(
  order: ReadonlyArray<ThreadId>,
  threads: ReadonlyArray<Thread>,
  threadByIdLookup: (threadId: ThreadId) => Thread | undefined,
): boolean {
  if (order.length !== threads.length) return false;
  let previous: Thread | undefined;
  for (const threadId of order) {
    const thread = threadByIdLookup(threadId);
    if (!thread) return false;
    if (previous && compareThreadsByActivity(previous, thread) > 0) return false;
    previous = thread;
  }
  return true;
}

function buildSummaryList(state: Pick<AppState, "threads">): SummaryListCache {
  const { threads } = state;
  if (threads === summaryList.threads) return summaryList;

  const index = selectThreadIndexById(state);
  const lookup = (threadId: ThreadId) => {
    const position = index.get(threadId);
    return position === undefined ? undefined : threads[position];
  };
  const orderCurrent = isActivityOrderCurrent(summaryList.activityOrder, threads, lookup);
  const activityOrder = orderCurrent
    ? summaryList.activityOrder
    : threads.toSorted(compareThreadsByActivity).map((thread) => thread.id);

  const summaryById = new Map<ThreadId, ThreadSummary>();
  const summaries: ThreadSummary[] = [];
  let changed = threads.length !== summaryList.summaries.length;
  for (let position = 0; position < threads.length; position += 1) {
    const thread = threads[position]!;
    const core = summaryCoreOf(thread);
    const previous = summaryList.summaryById.get(thread.id);
    // While the relative order holds, keep the previous ordering key so a
    // streaming delta that only bumps `lastInteractionAt` reuses the summary.
    const lastInteractionAt =
      orderCurrent && previous ? previous.lastInteractionAt : thread.lastInteractionAt;
    const summary =
      previous &&
      previous.lastInteractionAt === lastInteractionAt &&
      shallowEqualByKeys(
        previous as ThreadSummaryCore,
        core,
        SUMMARY_KEYS as ReadonlyArray<keyof ThreadSummaryCore>,
      )
        ? previous
        : { ...core, lastInteractionAt };
    summaryById.set(thread.id, summary);
    summaries.push(summary);
    if (!changed && summaryList.summaries[position] !== summary) changed = true;
  }

  for (const threadId of previousCoreById.keys()) {
    if (!index.has(threadId)) {
      previousCoreById.delete(threadId);
      statusMemoById.delete(threadId);
    }
  }

  summaryList = {
    threads,
    summaries: changed ? summaries : summaryList.summaries,
    summaryById: changed ? summaryById : summaryList.summaryById,
    activityOrder,
  };
  return summaryList;
}

/** Summaries in store order; the same array while every summary is unchanged. */
export function selectThreadSummaries(
  state: Pick<AppState, "threads">,
): ReadonlyArray<ThreadSummary> {
  return buildSummaryList(state).summaries;
}

export function selectThreadSummaryById(
  state: Pick<AppState, "threads">,
): ReadonlyMap<ThreadId, ThreadSummary> {
  return buildSummaryList(state).summaryById;
}

/** Thread ids, most recent activity first; the same array while the order holds. */
export function selectThreadActivityOrder(
  state: Pick<AppState, "threads">,
): ReadonlyArray<ThreadId> {
  return buildSummaryList(state).activityOrder;
}

// ── Ids ──────────────────────────────────────────────────────────────

export interface OrderedThreadScope {
  readonly projectId?: Project["id"] | undefined;
  /** Defaults to `false`: archived threads are left out. */
  readonly includeArchived?: boolean | undefined;
}

let threadIdsSource: ReadonlyArray<Thread> | null = null;
let threadIdsValue: ReadonlyArray<ThreadId> = [];

/** Thread ids in store order; the same array while the id sequence is unchanged. */
export function selectThreadIds(state: Pick<AppState, "threads">): ReadonlyArray<ThreadId> {
  const { threads } = state;
  if (threads === threadIdsSource) return threadIdsValue;
  threadIdsSource = threads;
  const unchanged =
    threads.length === threadIdsValue.length &&
    threads.every((thread, position) => thread.id === threadIdsValue[position]);
  if (!unchanged) threadIdsValue = threads.map((thread) => thread.id);
  return threadIdsValue;
}

// ── Hooks ────────────────────────────────────────────────────────────

export function useThreadSummaries(): ReadonlyArray<ThreadSummary> {
  return useStore(selectThreadSummaries);
}

export function useThreadSummary(threadId: ThreadId | null | undefined): ThreadSummary | undefined {
  return useStore((state) => (threadId ? selectThreadSummaryById(state).get(threadId) : undefined));
}

/**
 * Ids in activity order, optionally scoped to a project. Changes only when
 * the order or membership of the scope changes.
 */
export function useOrderedThreadIds(scope: OrderedThreadScope = {}): ReadonlyArray<ThreadId> {
  const { projectId, includeArchived = false } = scope;
  return useStore(
    useShallow((state) => {
      const order = selectThreadActivityOrder(state);
      if (projectId === undefined && includeArchived) return order;
      const summaryById = selectThreadSummaryById(state);
      return order.filter((threadId) => {
        const summary = summaryById.get(threadId);
        if (!summary) return false;
        if (projectId !== undefined && summary.projectId !== projectId) return false;
        return includeArchived || summary.archivedAt === null;
      });
    }),
  );
}

/** The live `lastInteractionAt` of one thread, for relative-time leaves. */
export function useThreadActivityAt(threadId: ThreadId | null | undefined): string | null {
  return useStore((state) => selectThreadById(state, threadId)?.lastInteractionAt ?? null);
}

/**
 * Activity buckets ("Today", ...) from each thread's live activity time.
 * Summaries keep `lastInteractionAt` as an ordering key only, so grouping
 * can't use it; this re-renders only when a thread changes bucket.
 */
export function useLiveActivityBuckets(
  threads: ReadonlyArray<Pick<ThreadSummary, "id" | "lastInteractionAt">>,
  now: number,
): ReadonlyArray<ActivityBucket> {
  return useStore(useShallow((state) => selectLiveActivityBuckets(state, threads, now)));
}

export function selectLiveActivityBuckets(
  state: Pick<AppState, "threads">,
  threads: ReadonlyArray<Pick<ThreadSummary, "id" | "lastInteractionAt">>,
  now: number,
): ActivityBucket[] {
  const reference = new Date(now);
  return threads.map((thread) =>
    bucketActivityAt(
      // Summaries' value is the fallback for drafts that aren't in the store.
      selectThreadById(state, thread.id)?.lastInteractionAt ?? thread.lastInteractionAt,
      reference,
    ),
  );
}

/** The full thread; re-renders whenever that thread changes. */
export function useThread(threadId: ThreadId | null | undefined): Thread | undefined {
  return useStore((state) => selectThreadById(state, threadId));
}

export function useThreadExists(threadId: ThreadId | null | undefined): boolean {
  return useStore((state) => (threadId ? selectThreadIndexById(state).has(threadId) : false));
}

export function useThreadIds(): ReadonlyArray<ThreadId> {
  return useStore(selectThreadIds);
}

/**
 * Full threads for a fixed id list, in the order given. Missing ids are left
 * out. Re-renders only when one of those threads changes.
 */
export function useThreadsByIds(threadIds: ReadonlyArray<ThreadId>): Thread[] {
  return useStore(
    useShallow((state) => {
      const threads: Thread[] = [];
      for (const threadId of threadIds) {
        const thread = selectThreadById(state, threadId);
        if (thread) threads.push(thread);
      }
      return threads;
    }),
  );
}

export interface ThreadWorkspace {
  readonly projectId: Project["id"];
  readonly worktreePath: string | null;
}

/** The project and worktree of a thread; stable across message deltas. */
export function useThreadWorkspace(threadId: ThreadId | null | undefined): ThreadWorkspace | null {
  return useStore(
    useShallow((state) => {
      const thread = selectThreadById(state, threadId);
      return thread ? { projectId: thread.projectId, worktreePath: thread.worktreePath } : null;
    }),
  );
}
