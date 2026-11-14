import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/** How an approval was closed from Home, until the store drops the request. */
export type HomeClosedApprovalState = "sent" | "answered";

interface HomeInlineState {
  /** Threads with an action from Home in flight: one at a time per thread. */
  readonly busyThreadIds: ReadonlySet<ThreadId>;
  /** Approvals closed from Home, by `closedApprovalKey`. */
  readonly closedApprovals: ReadonlyMap<string, HomeClosedApprovalState>;
  /** Unsent replies per thread: selecting another row keeps them. */
  readonly replyDrafts: ReadonlyMap<ThreadId, string>;
}

const EMPTY: HomeInlineState = {
  busyThreadIds: new Set(),
  closedApprovals: new Map(),
  replyDrafts: new Map(),
};

/**
 * What Home's inline actions have in flight or have just done. It lives outside the
 * preview because the preview remounts whenever the selection moves: a decision sent,
 * then J and K pressed within its round trip, must still find the thread busy and the
 * request closed, or the same request could be answered twice. Held in memory only.
 */
export const useHomeInlineStore = create<HomeInlineState>(() => EMPTY);

function closedApprovalKey(threadId: ThreadId, requestId: string): string {
  return `${threadId}\n${requestId}`;
}

/** Claims the thread for one action; false when another is still in flight. */
export function beginHomeThreadAction(threadId: ThreadId): boolean {
  const { busyThreadIds } = useHomeInlineStore.getState();
  if (busyThreadIds.has(threadId)) return false;
  useHomeInlineStore.setState({ busyThreadIds: new Set(busyThreadIds).add(threadId) });
  return true;
}

export function endHomeThreadAction(threadId: ThreadId): void {
  const busyThreadIds = new Set(useHomeInlineStore.getState().busyThreadIds);
  if (busyThreadIds.delete(threadId)) useHomeInlineStore.setState({ busyThreadIds });
}

export function isHomeThreadBusy(threadId: ThreadId): boolean {
  return useHomeInlineStore.getState().busyThreadIds.has(threadId);
}

export function markHomeApprovalClosed(
  threadId: ThreadId,
  requestId: string,
  state: HomeClosedApprovalState,
): void {
  useHomeInlineStore.setState((current) => ({
    closedApprovals: new Map(current.closedApprovals).set(
      closedApprovalKey(threadId, requestId),
      state,
    ),
  }));
}

export function homeApprovalClosedState(
  closedApprovals: HomeInlineState["closedApprovals"],
  threadId: ThreadId,
  requestId: string,
): HomeClosedApprovalState | null {
  return closedApprovals.get(closedApprovalKey(threadId, requestId)) ?? null;
}

/** Drops the thread's closed requests the store no longer lists as open. */
export function forgetSettledHomeApprovals(
  threadId: ThreadId,
  openRequestIds: ReadonlyArray<string>,
): void {
  const { closedApprovals } = useHomeInlineStore.getState();
  const keep = new Set(openRequestIds.map((requestId) => closedApprovalKey(threadId, requestId)));
  const prefix = closedApprovalKey(threadId, "");
  const next = new Map(closedApprovals);
  for (const key of closedApprovals.keys()) {
    if (key.startsWith(prefix) && !keep.has(key)) next.delete(key);
  }
  if (next.size !== closedApprovals.size) useHomeInlineStore.setState({ closedApprovals: next });
}

export function setHomeReplyDraft(threadId: ThreadId, text: string): void {
  const { replyDrafts } = useHomeInlineStore.getState();
  if ((replyDrafts.get(threadId) ?? "") === text) return;
  const next = new Map(replyDrafts);
  if (text) next.set(threadId, text);
  else next.delete(threadId);
  useHomeInlineStore.setState({ replyDrafts: next });
}

export function resetHomeInlineStoreForTests(): void {
  useHomeInlineStore.setState(EMPTY);
}
