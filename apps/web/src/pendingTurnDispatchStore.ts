import {
  type ClientOrchestrationCommand,
  type CommandId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { LocalDispatchSnapshot } from "./session-logic";
import type {
  PendingTurnDispatchRollback,
  PendingTurnDispatchStatus,
} from "./components/ChatView.logic";

export type PendingTurnStartCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.turn.start" }
>;

export interface PendingTurnDispatchState {
  status: PendingTurnDispatchStatus;
  commandId: CommandId;
  messageId: MessageId;
  optimisticMessageId: MessageId;
  createdAt: string;
  preparingWorktree: boolean;
  localDispatch: LocalDispatchSnapshot;
  acceptedSequence: number | null;
  awaitingRecoveryAfterEpoch: number | null;
  lastResolvedRecoveryEpoch: number | null;
}

export interface PendingTurnDispatchArtifacts {
  command: PendingTurnStartCommand;
  rollback: PendingTurnDispatchRollback;
}

interface PendingTurnDispatchStoreState {
  pendingByThreadId: Partial<Record<ThreadId, PendingTurnDispatchState>>;
  setPendingTurnDispatch: (threadId: ThreadId, pending: PendingTurnDispatchState) => void;
  updatePendingTurnDispatch: (
    threadId: ThreadId,
    updater: (current: PendingTurnDispatchState | null) => PendingTurnDispatchState | null,
  ) => void;
  clearPendingTurnDispatch: (threadId: ThreadId) => void;
}

const pendingTurnDispatchArtifactsByCommandId = new Map<CommandId, PendingTurnDispatchArtifacts>();

export function getPendingTurnDispatchArtifacts(
  commandId: CommandId,
): PendingTurnDispatchArtifacts | undefined {
  return pendingTurnDispatchArtifactsByCommandId.get(commandId);
}

export function setPendingTurnDispatchArtifacts(
  commandId: CommandId,
  artifacts: PendingTurnDispatchArtifacts,
): void {
  pendingTurnDispatchArtifactsByCommandId.set(commandId, artifacts);
}

export function deletePendingTurnDispatchArtifacts(commandId: CommandId): void {
  pendingTurnDispatchArtifactsByCommandId.delete(commandId);
}

export function listPendingTurnDispatchArtifacts(): PendingTurnDispatchArtifacts[] {
  return Array.from(pendingTurnDispatchArtifactsByCommandId.values());
}

export function clearAllPendingTurnDispatchArtifacts(): void {
  pendingTurnDispatchArtifactsByCommandId.clear();
}

export const usePendingTurnDispatchStore = create<PendingTurnDispatchStoreState>((set) => ({
  pendingByThreadId: {},
  setPendingTurnDispatch: (threadId, pending) =>
    set((state) => ({
      pendingByThreadId: {
        ...state.pendingByThreadId,
        [threadId]: pending,
      },
    })),
  updatePendingTurnDispatch: (threadId, updater) =>
    set((state) => {
      const current = state.pendingByThreadId[threadId] ?? null;
      const next = updater(current);
      if (next === current) {
        return state;
      }
      if (!next) {
        if (!(threadId in state.pendingByThreadId)) {
          return state;
        }
        const pendingByThreadId = { ...state.pendingByThreadId };
        delete pendingByThreadId[threadId];
        return { pendingByThreadId };
      }
      return {
        pendingByThreadId: {
          ...state.pendingByThreadId,
          [threadId]: next,
        },
      };
    }),
  clearPendingTurnDispatch: (threadId) =>
    set((state) => {
      if (!(threadId in state.pendingByThreadId)) {
        return state;
      }
      const pendingByThreadId = { ...state.pendingByThreadId };
      delete pendingByThreadId[threadId];
      return { pendingByThreadId };
    }),
}));
