import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ComposerFocusRequest {
  readonly threadId: ThreadId;
  readonly nonce: number;
}

interface ComposerFocusRequestState {
  request: ComposerFocusRequest | null;
  /** Ask the chat view for `threadId` to focus its composer once it mounts. */
  requestComposerFocus: (threadId: ThreadId) => void;
  /** Clears the request if it is still the one the caller handled. */
  clearComposerFocusRequest: (nonce: number) => void;
}

let nextNonce = 1;

/**
 * Cross-route handoff for "start typing here": Home prefills a draft, then
 * navigates; the thread's ChatView consumes the request and focuses its
 * composer. Never sends anything.
 */
export const useComposerFocusRequestStore = create<ComposerFocusRequestState>((set) => ({
  request: null,
  requestComposerFocus: (threadId) => {
    nextNonce += 1;
    set({ request: { threadId, nonce: nextNonce } });
  },
  clearComposerFocusRequest: (nonce) =>
    set((state) => (state.request?.nonce === nonce ? { request: null } : state)),
}));

export function requestComposerFocus(threadId: ThreadId): void {
  useComposerFocusRequestStore.getState().requestComposerFocus(threadId);
}
