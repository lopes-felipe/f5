import type { ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ThreadFindMatch } from "./ThreadFindBar";
import type { useTimelineNavigation } from "./useTimelineNavigation";

type TimelineNavigation = Pick<
  ReturnType<typeof useTimelineNavigation>,
  "navigate" | "cancelRequest" | "retry" | "handleSelectedRange"
>;

/**
 * Find in thread: whether the bar is open, which match is active, and the
 * timeline jump that brings that match into view.
 *
 * The open bar and the active match are remembered per thread id, so a view
 * that switches thread shows neither until that thread opens its own.
 */
export function useThreadFind({
  threadId,
  navigation,
}: {
  readonly threadId: ThreadId;
  readonly navigation: TimelineNavigation;
}) {
  const { navigate, cancelRequest, retry, handleSelectedRange } = navigation;
  const [openThreadId, setOpenThreadId] = useState<ThreadId | null>(null);
  const [selection, setSelection] = useState<{
    threadId: ThreadId;
    match: ThreadFindMatch;
    requestId: number | null;
  } | null>(null);
  const match = selection?.threadId === threadId ? selection.match : null;
  const requestId = selection?.threadId === threadId ? selection.requestId : null;

  useEffect(() => {
    const onFindThread = (event: Event) => {
      if ((event as CustomEvent<ThreadId>).detail === threadId) setOpenThreadId(threadId);
    };
    window.addEventListener("f5:find-thread", onFindThread);
    return () => window.removeEventListener("f5:find-thread", onFindThread);
  }, [threadId]);

  // The navigation request serving the current find match. A retry moves it to
  // the new request id, so the match row's range report is still accepted.
  const ticketRef = useRef<{ id: number } | null>(null);
  const cancelNavigation = useCallback(() => {
    const ticket = ticketRef.current;
    if (!ticket) return;
    // Forgotten here, so a later retry of some other jump can never be taken for this one.
    ticketRef.current = null;
    cancelRequest(ticket.id);
  }, [cancelRequest]);

  const open = useCallback(() => setOpenThreadId(threadId), [threadId]);

  /** Drops the active match and keeps the bar and its query, so Previous/Next pick it back up. */
  const clearMatch = useCallback(() => setSelection(null), []);

  const close = useCallback(() => {
    cancelNavigation();
    setOpenThreadId(null);
    setSelection(null);
  }, [cancelNavigation]);

  /** The find bar's result for `forThreadId`: jump to it, or clear when the search has none. */
  const selectMatch = useCallback(
    async (forThreadId: ThreadId, next: ThreadFindMatch | null, signal: AbortSignal) => {
      if (signal.aborted) return;
      if (!next) {
        cancelNavigation();
        setSelection(null);
        return;
      }
      // A plan result is injected into the timeline first, so it is
      // awaited in the row map rather than loaded as history.
      const ticket = {
        id: navigate(next.entryId, {
          load: next.kind === "message",
          position: 0.3,
          placeRange: true,
        }),
      };
      ticketRef.current = ticket;
      // The search is aborted when the query or index changes or the
      // bar closes; its jump (or that jump's retry) must not land later.
      signal.addEventListener("abort", () => cancelRequest(ticket.id), { once: true });
      setSelection({ threadId: forThreadId, match: next, requestId: ticket.id });
    },
    [cancelNavigation, cancelRequest, navigate],
  );

  /** Retries the last timeline jump; a find match that owned it follows the new request. */
  const retryNavigation = useCallback(() => {
    const retried = retry();
    if (!retried) return;
    const ticket = ticketRef.current;
    if (ticket?.id !== retried.previousId) return;
    ticket.id = retried.id;
    setSelection((current) =>
      current?.requestId === retried.previousId ? { ...current, requestId: retried.id } : current,
    );
  }, [retry]);

  /** For `ThreadFindContext`: what the timeline rows highlight. */
  const contextValue = useMemo(
    () =>
      match
        ? {
            entryId: match.entryId,
            query: match.query,
            occurrence: match.occurrence,
            requestId,
            onSelectedRange: handleSelectedRange,
          }
        : null,
    [match, requestId, handleSelectedRange],
  );

  return {
    openThreadId,
    match,
    contextValue,
    open,
    close,
    clearMatch,
    selectMatch,
    retryNavigation,
  };
}
