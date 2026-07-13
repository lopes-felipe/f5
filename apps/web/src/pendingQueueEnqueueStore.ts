import type { CommandId, NextTurnSubmitActiveTurnAction, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { PendingTurnDispatchRollback } from "./components/ChatView.logic";
import type { OptimisticQueuedTurn } from "./components/chat/NextTurnQueuePanel";
import type { PendingTurnStartCommand } from "./pendingTurnDispatchStore";

export interface PendingQueueEnqueueState {
  readonly itemId: CommandId;
  readonly threadId: ThreadId;
  readonly command: PendingTurnStartCommand;
  readonly rollback: PendingTurnDispatchRollback;
  readonly optimisticItem: OptimisticQueuedTurn;
  /** Captures the send-time placement so a later phase change cannot make an
   * already-started turn appear as a queued item while its response is pending. */
  readonly displayInQueue: boolean;
  readonly activeTurnAction: NextTurnSubmitActiveTurnAction;
  readonly status: "enqueueing" | "awaiting-recovery";
}

interface PendingQueueEnqueueStoreState {
  readonly pendingByThreadId: Partial<Record<ThreadId, PendingQueueEnqueueState>>;
  readonly setPending: (pending: PendingQueueEnqueueState) => void;
  readonly updatePending: (
    threadId: ThreadId,
    update: (current: PendingQueueEnqueueState) => PendingQueueEnqueueState,
  ) => void;
  readonly clearPending: (threadId: ThreadId, itemId?: CommandId) => void;
}

export const usePendingQueueEnqueueStore = create<PendingQueueEnqueueStoreState>((set) => ({
  pendingByThreadId: {},
  setPending: (pending) =>
    set((state) => ({
      pendingByThreadId: { ...state.pendingByThreadId, [pending.threadId]: pending },
    })),
  updatePending: (threadId, update) =>
    set((state) => {
      const current = state.pendingByThreadId[threadId];
      if (!current) return state;
      return {
        pendingByThreadId: {
          ...state.pendingByThreadId,
          [threadId]: update(current),
        },
      };
    }),
  clearPending: (threadId, itemId) =>
    set((state) => {
      const current = state.pendingByThreadId[threadId];
      if (!current || (itemId !== undefined && current.itemId !== itemId)) return state;
      const pendingByThreadId = { ...state.pendingByThreadId };
      delete pendingByThreadId[threadId];
      return { pendingByThreadId };
    }),
}));
