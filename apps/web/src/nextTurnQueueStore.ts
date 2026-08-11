import type {
  CommandId,
  NextTurnQueueSnapshot,
  NextTurnQueueSummary,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface OptimisticQueuedTurn {
  readonly submissionId: CommandId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly createdAtMs: number;
}

export interface NextTurnQueueThreadState {
  readonly snapshot: NextTurnQueueSnapshot | null;
  readonly pendingOrder: ReadonlyArray<CommandId> | null;
  readonly busyItemIds: ReadonlyArray<CommandId>;
  readonly optimistic: ReadonlyArray<OptimisticQueuedTurn>;
  readonly hydrated: boolean;
  readonly syncError: string | null;
}

export const EMPTY_QUEUE_THREAD_STATE: NextTurnQueueThreadState = Object.freeze({
  snapshot: null,
  pendingOrder: null,
  busyItemIds: Object.freeze([]),
  optimistic: Object.freeze([]),
  hydrated: false,
  syncError: null,
});

interface NextTurnQueueStoreState {
  readonly byThreadId: Partial<Record<ThreadId, NextTurnQueueThreadState>>;
  readonly summary: NextTurnQueueSummary;
  readonly applySnapshot: (snapshot: NextTurnQueueSnapshot) => void;
  readonly applySummary: (summary: NextTurnQueueSummary) => void;
  readonly invalidateSnapshots: () => void;
  readonly setHydrationError: (threadId: ThreadId, message: string | null) => void;
  readonly setPendingOrder: (threadId: ThreadId, order: ReadonlyArray<CommandId> | null) => void;
  readonly setItemBusy: (threadId: ThreadId, itemId: CommandId, busy: boolean) => void;
  readonly addOptimistic: (optimistic: OptimisticQueuedTurn) => void;
  readonly removeOptimistic: (threadId: ThreadId, submissionId: CommandId) => void;
  readonly expireStaleOptimistic: (nowMs?: number) => void;
}

function stateFor(
  byThreadId: NextTurnQueueStoreState["byThreadId"],
  threadId: ThreadId,
): NextTurnQueueThreadState {
  return byThreadId[threadId] ?? EMPTY_QUEUE_THREAD_STATE;
}

export const useNextTurnQueueStore = create<NextTurnQueueStoreState>((set) => ({
  byThreadId: {},
  summary: { threads: [] },
  applySnapshot: (snapshot) =>
    set((state) => {
      const current = stateFor(state.byThreadId, snapshot.threadId);
      if (current.snapshot !== null && snapshot.revision < current.snapshot.revision) {
        return state;
      }
      if (
        current.snapshot !== null &&
        snapshot.revision === current.snapshot.revision &&
        JSON.stringify(snapshot) === JSON.stringify(current.snapshot)
      ) {
        return state;
      }
      const serverOrder = snapshot.items.map((item) => item.itemId);
      const pendingOrder =
        current.pendingOrder !== null &&
        current.pendingOrder.length === serverOrder.length &&
        current.pendingOrder.every((itemId, index) => itemId === serverOrder[index])
          ? null
          : current.pendingOrder;
      const liveIds = new Set(serverOrder);
      const submissionIds = new Set(snapshot.items.map((item) => item.submissionId));
      return {
        byThreadId: {
          ...state.byThreadId,
          [snapshot.threadId]: {
            ...current,
            snapshot,
            pendingOrder,
            busyItemIds: current.busyItemIds.filter((itemId) => liveIds.has(itemId)),
            optimistic: current.optimistic.filter((item) => !submissionIds.has(item.submissionId)),
            hydrated: true,
            syncError: null,
          },
        },
      };
    }),
  applySummary: (summary) => set({ summary }),
  invalidateSnapshots: () =>
    set((state) => ({
      byThreadId: Object.fromEntries(
        Object.entries(state.byThreadId).map(([threadId, current]) => [
          threadId,
          {
            ...current,
            snapshot: null,
            pendingOrder: null,
            busyItemIds: [],
            hydrated: false,
            syncError: null,
          },
        ]),
      ) as NextTurnQueueStoreState["byThreadId"],
    })),
  setHydrationError: (threadId, message) =>
    set((state) => ({
      byThreadId: {
        ...state.byThreadId,
        [threadId]: {
          ...stateFor(state.byThreadId, threadId),
          hydrated: message === null,
          syncError: message,
        },
      },
    })),
  setPendingOrder: (threadId, pendingOrder) =>
    set((state) => ({
      byThreadId: {
        ...state.byThreadId,
        [threadId]: { ...stateFor(state.byThreadId, threadId), pendingOrder },
      },
    })),
  setItemBusy: (threadId, itemId, busy) =>
    set((state) => {
      const current = stateFor(state.byThreadId, threadId);
      const busyIds = new Set(current.busyItemIds);
      if (busy) busyIds.add(itemId);
      else busyIds.delete(itemId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: { ...current, busyItemIds: [...busyIds] },
        },
      };
    }),
  addOptimistic: (optimistic) =>
    set((state) => {
      const current = stateFor(state.byThreadId, optimistic.threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [optimistic.threadId]: {
            ...current,
            optimistic: [
              ...current.optimistic.filter((item) => item.submissionId !== optimistic.submissionId),
              optimistic,
            ].slice(-3),
          },
        },
      };
    }),
  removeOptimistic: (threadId, submissionId) =>
    set((state) => {
      const current = stateFor(state.byThreadId, threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...current,
            optimistic: current.optimistic.filter((item) => item.submissionId !== submissionId),
          },
        },
      };
    }),
  expireStaleOptimistic: (nowMs = Date.now()) =>
    set((state) => {
      let changed = false;
      const byThreadId = { ...state.byThreadId };
      for (const [threadId, current] of Object.entries(byThreadId) as Array<
        [ThreadId, NextTurnQueueThreadState]
      >) {
        const optimistic = current.optimistic.filter((item) => nowMs - item.createdAtMs < 15_000);
        if (optimistic.length !== current.optimistic.length) {
          changed = true;
          byThreadId[threadId] = { ...current, optimistic };
        }
      }
      return changed ? { byThreadId } : state;
    }),
}));

export function useNextTurnQueueCount(threadId: ThreadId): number {
  return useNextTurnQueueStore((state) => {
    const local = state.byThreadId[threadId]?.snapshot?.items.length;
    if (local !== undefined) return local;
    const summary = (state.summary?.threads ?? []).find((entry) => entry.threadId === threadId);
    return summary ? summary.queuedCount + summary.dispatchingCount + summary.failedCount : 0;
  });
}

export function useNextTurnQueueBadge(threadId: ThreadId): "none" | "queued" | "paused" {
  return useNextTurnQueueStore((state) => {
    const local = state.byThreadId[threadId]?.snapshot;
    if (local) return local.paused ? "paused" : local.items.length > 0 ? "queued" : "none";
    const summary = (state.summary?.threads ?? []).find((entry) => entry.threadId === threadId);
    if (!summary) return "none";
    if (summary.paused) return "paused";
    return summary.queuedCount + summary.dispatchingCount + summary.failedCount > 0
      ? "queued"
      : "none";
  });
}
