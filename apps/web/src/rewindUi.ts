import type { MessageId, NativeApi, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";
import {
  applyRewindUiEvent,
  EMPTY_REWIND_UI_STATE,
  withoutKey,
  type LandedRewind,
  type PendingRewind,
  type RewindPromptPreview,
  type RewindUiEffect,
  type RewindUiState,
} from "./rewindUi.logic";
import { useStore } from "./store";

export type {
  LandedRewind,
  PendingRewind,
  RevertReopenRequest,
  RewindPromptPreview,
  RewindUiState,
} from "./rewindUi.logic";

/**
 * Client-only state for conversation reverts ("rewinds" on the server).
 *
 * The server tells us when a rewind is requested, lands, is resolved, or fails,
 * but nothing in between. This store turns those events into what the UI shows:
 * a pending revert (rows dimmed, sending paused), a just-landed revert (the
 * recovered prompt rendered before the snapshot refetch delivers the real draft),
 * and requests to reopen the revert popover. It lives outside the thread model
 * because snapshot syncs rebuild threads and would drop client-only fields.
 */
export const useRewindUiStore = create<RewindUiState>(() => EMPTY_REWIND_UI_STATE);

let reopenNonce = 0;

export const rewindUi = {
  /** Optimistic: called right before dispatching, so the UI reacts on click. */
  markPending(rewind: PendingRewind): void {
    useRewindUiStore.setState((state) => ({
      pendingByThreadId: { ...state.pendingByThreadId, [rewind.threadId]: rewind },
    }));
  },
  clearPending(threadId: ThreadId, operationId: string): void {
    useRewindUiStore.setState((state) =>
      state.pendingByThreadId[threadId]?.operationId === operationId
        ? { pendingByThreadId: withoutKey(state.pendingByThreadId, threadId) }
        : state,
    );
  },
  setDraftHidden(operationId: string, hidden: boolean): void {
    useRewindUiStore.setState((state) => ({
      hiddenDraftOperationIds: hidden
        ? { ...state.hiddenDraftOperationIds, [operationId]: true as const }
        : withoutKey(state.hiddenDraftOperationIds, operationId),
    }));
  },
  requestReopen(threadId: ThreadId, messageId: MessageId, restoreFiles: boolean): void {
    reopenNonce += 1;
    useRewindUiStore.setState((state) => ({
      reopenByThreadId: {
        ...state.reopenByThreadId,
        [threadId]: { messageId, restoreFiles, nonce: reopenNonce },
      },
    }));
  },
};

function capturePromptFromStore(
  threadId: ThreadId,
  messageId: MessageId,
): RewindPromptPreview | null {
  const message = useStore
    .getState()
    .threads.find((thread) => thread.id === threadId)
    ?.messages.find((candidate) => candidate.id === messageId);
  if (!message) return null;
  return {
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
    })),
  };
}

function describeRevertedFiles(rewind: LandedRewind): string {
  if (!rewind.restoreFiles) return "File changes kept.";
  const count = rewind.changedFileCount ?? 0;
  return count > 0
    ? `Restored ${count} ${count === 1 ? "file" : "files"} to before that message.`
    : "Files restored to before that message.";
}

function runEffect(effect: RewindUiEffect): void {
  if (effect.kind === "reverted") {
    toastManager.add({
      type: "success",
      title: "Conversation reverted",
      description: describeRevertedFiles(effect.rewind),
      data: { threadId: effect.rewind.threadId },
    });
    return;
  }
  // A failure that got far enough to record an operation is explained by the
  // rewind panel above the composer; only failures before that need a toast.
  if (!effect.preflight) return;
  const { threadId, targetMessageId } = effect;
  toastManager.add({
    type: "error",
    title: "Couldn't revert",
    description: effect.detail,
    data: { threadId },
    ...(effect.restoreFiles && targetMessageId !== null
      ? {
          actionProps: {
            children: "Revert keeping files",
            onClick: () => rewindUi.requestReopen(threadId, targetMessageId, false),
          },
        }
      : {}),
  });
}

let subscribed = false;

/** Starts the app-wide event subscription once; later calls are no-ops. */
export function ensureRewindUiSubscription(api: NativeApi): void {
  if (subscribed) return;
  subscribed = true;
  api.orchestration.onDomainEvent((event) => {
    const current = useRewindUiStore.getState();
    const result = applyRewindUiEvent(current, event, capturePromptFromStore);
    if (result.state !== current) useRewindUiStore.setState(result.state);
    if (result.effect) runEffect(result.effect);
  });
}
