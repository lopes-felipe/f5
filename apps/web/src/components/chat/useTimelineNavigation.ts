import type { LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { TimelineAnchorUnavailableError } from "../../lib/orchestrationReactQuery";

export type TimelineNavigationStatus = "idle" | "loading" | "failed" | "unavailable";

export interface TimelineNavigateOptions {
  /** The kind of history anchor to load when the target is not loaded yet. */
  anchorKind?: "message" | "activity";
  /** False when the target appears without a history load (an injected plan). */
  load?: boolean;
  /** Where the target lands, as a fraction of the viewport from the top. */
  position?: number;
  animated?: boolean;
  /**
   * A find match: after the row lands, its active range is reported back with
   * the request id and placed once at `position`.
   */
  placeRange?: boolean;
}

interface PendingNavigation {
  readonly id: number;
  readonly entryId: string;
  readonly options: TimelineNavigateOptions;
  readonly controller: AbortController;
  stage: "resolving" | "settling" | "awaiting-range";
  /** The find range the target row reported, placed once the row has settled. */
  range: Range | null;
  timer: number | null;
  frame: number | null;
  detachInput: () => void;
}

/** Placement is re-applied while the list measures rows, for at most this many frames. */
const PLACEMENT_SETTLE_MAX_FRAMES = 60;
const PLACEMENT_STABLE_FRAMES = 3;

/** How long a loaded or injected target may take to reach the row map, and a placed row to report its range. */
export const TIMELINE_NAVIGATION_SETTLE_MS = 1_500;

const MANUAL_NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * Owns every jump to a timeline entry (rail, minimap, navigation popover, find,
 * focus requests): resolves it through the row map, loads missing history once,
 * and places the target once. Manual scrolling, Jump to latest, a newer request
 * or a thread change cancel whatever is pending. Bottom-following stays with
 * the timeline.
 */
export function useTimelineNavigation(input: {
  threadId: string | null;
  listRef: RefObject<LegendListRef | null>;
  entryRowIndexMapRef: RefObject<ReadonlyMap<string, number> | null>;
  loadAround: (
    entryId: string,
    anchorKind: "message" | "activity",
    signal: AbortSignal,
  ) => Promise<void>;
  onLeaveEnd: () => void;
  /** Bumped when a new turn is followed; following wins over a pending jump. */
  followNextTailNonce: number;
}) {
  const { threadId, listRef, entryRowIndexMapRef, followNextTailNonce } = input;
  const [state, setState] = useState<{
    threadId: string | null;
    status: TimelineNavigationStatus;
  }>({ threadId, status: "idle" });
  const status = state.threadId === threadId ? state.status : "idle";
  const callbacksRef = useRef(input);
  useLayoutEffect(() => {
    callbacksRef.current = input;
  });
  const pendingRef = useRef<PendingNavigation | null>(null);
  const lastRequestRef = useRef<{
    id: number;
    entryId: string;
    options: TimelineNavigateOptions;
  } | null>(null);
  const nextRequestIdRef = useRef(0);
  /** The request whose failure the current failed/unavailable status reports. */
  const statusOwnerRef = useRef<number | null>(null);

  /**
   * Ends `pending` for good. Its in-flight history load is aborted too: once
   * the target landed (or the jump was given up), a late anchored page must not
   * shift the rows the reader is now looking at.
   */
  const settle = useCallback(
    (pending: PendingNavigation, next: TimelineNavigationStatus) => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      pending.controller.abort();
      pending.detachInput();
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      if (pending.frame !== null) window.cancelAnimationFrame(pending.frame);
      statusOwnerRef.current = next === "idle" ? null : pending.id;
      setState({ threadId, status: next });
    },
    [threadId],
  );

  /** Aborts any pending request and clears a failed or unavailable status. */
  const cancel = useCallback(() => {
    const pending = pendingRef.current;
    if (pending) {
      settle(pending, "idle");
      return;
    }
    statusOwnerRef.current = null;
    setState((current) =>
      current.threadId === threadId && current.status === "idle"
        ? current
        : { threadId, status: "idle" },
    );
  }, [settle, threadId]);

  /** Scrolls the reported find range to the request's position, once. */
  const placeRange = useCallback(
    (pending: PendingNavigation) => {
      const node = listRef.current?.getScrollableNode?.();
      // Highlighter mutations can detach the reported range; the live active
      // highlight then stands in for it.
      let rect = pending.range?.getBoundingClientRect();
      if (!rect?.height && typeof CSS !== "undefined" && CSS.highlights) {
        const [live] = CSS.highlights.get("f5-thread-find-active") ?? [];
        if (live instanceof Range) rect = live.getBoundingClientRect();
      }
      if (node instanceof HTMLElement && rect && rect.height > 0) {
        node.scrollBy({
          top:
            rect.top -
            node.getBoundingClientRect().top -
            node.clientHeight * (pending.options.position ?? 0.3),
          behavior: "instant",
        });
      }
      settle(pending, "idle");
    },
    [listRef, settle],
  );

  const place = useCallback(
    (pending: PendingNavigation) => {
      const index = entryRowIndexMapRef.current?.get(pending.entryId);
      if (index === undefined) return false;
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pending.timer = null;
      callbacksRef.current.onLeaveEnd();
      const node = listRef.current?.getScrollableNode?.();
      if (
        pending.options.placeRange &&
        node instanceof HTMLElement &&
        node.querySelector(`[data-timeline-row-id="${CSS.escape(pending.entryId)}"]`)
      ) {
        // The row is already rendered (Next/Previous within one message): go
        // straight to the match instead of first snapping to the row's top.
        setState({ threadId, status: "idle" });
        pending.stage = "awaiting-range";
        if (pending.range) placeRange(pending);
        else
          pending.timer = window.setTimeout(
            () => placeRange(pending),
            TIMELINE_NAVIGATION_SETTLE_MS,
          );
        return true;
      }
      const animated = pending.options.animated ?? false;
      const scrollToTarget = () => {
        const current = entryRowIndexMapRef.current?.get(pending.entryId) ?? index;
        void listRef.current?.scrollToIndex({
          index: current,
          animated,
          viewPosition: pending.options.position ?? 0.3,
        });
      };
      scrollToTarget();
      setState({ threadId, status: "idle" });
      const finish = () => {
        if (!pending.options.placeRange) {
          settle(pending, "idle");
          return;
        }
        // The row has landed; its active range is placed once it is reported.
        pending.stage = "awaiting-range";
        if (pending.range) {
          placeRange(pending);
          return;
        }
        // The exact occurrence never rendered: place the best live highlight.
        pending.timer = window.setTimeout(() => placeRange(pending), TIMELINE_NAVIGATION_SETTLE_MS);
      };
      if (animated) {
        finish();
        return true;
      }
      // Freshly loaded rows are measured over the next frames and the list
      // re-anchors as they resize; keep the target placed until that settles.
      pending.stage = "settling";
      let frames = 0;
      let stableFrames = 0;
      let lastHeight = -1;
      const settleFrame = () => {
        pending.frame = null;
        if (pendingRef.current !== pending) return;
        const node = listRef.current?.getScrollableNode?.();
        const height = node instanceof HTMLElement ? node.scrollHeight : 0;
        if (height !== lastHeight) {
          stableFrames = 0;
          lastHeight = height;
          scrollToTarget();
        } else {
          stableFrames += 1;
        }
        frames += 1;
        if (stableFrames >= PLACEMENT_STABLE_FRAMES || frames >= PLACEMENT_SETTLE_MAX_FRAMES) {
          finish();
          return;
        }
        pending.frame = window.requestAnimationFrame(settleFrame);
      };
      pending.frame = window.requestAnimationFrame(settleFrame);
      return true;
    },
    [entryRowIndexMapRef, listRef, placeRange, settle, threadId],
  );

  const navigate = useCallback(
    (entryId: string, options: TimelineNavigateOptions = {}) => {
      cancel();
      const id = ++nextRequestIdRef.current;
      const pending: PendingNavigation = {
        id,
        entryId,
        options,
        controller: new AbortController(),
        stage: "resolving",
        range: null,
        timer: null,
        frame: null,
        detachInput: () => {},
      };
      pendingRef.current = pending;
      lastRequestRef.current = { id, entryId, options };

      const node = listRef.current?.getScrollableNode?.();
      if (node instanceof HTMLElement) {
        const onManualInput = (event: Event) => {
          if (event instanceof KeyboardEvent && !MANUAL_NAVIGATION_KEYS.has(event.key)) return;
          pending.controller.abort();
          settle(pending, "idle");
        };
        const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
        for (const type of events) node.addEventListener(type, onManualInput, { passive: true });
        pending.detachInput = () => {
          for (const type of events) node.removeEventListener(type, onManualInput);
        };
      }

      if (place(pending)) return id;
      setState({ threadId, status: "loading" });
      const waitForRowMap = () => {
        if (pendingRef.current !== pending || pending.stage !== "resolving") return;
        if (place(pending)) return;
        // A target the server just returned is not known to be gone: a row map
        // that is slow to commit is offered as a retry, not reported missing.
        pending.timer = window.setTimeout(
          () => settle(pending, options.load === false ? "unavailable" : "failed"),
          TIMELINE_NAVIGATION_SETTLE_MS,
        );
      };
      if (options.load === false) {
        waitForRowMap();
        return id;
      }
      callbacksRef.current
        .loadAround(entryId, options.anchorKind ?? "message", pending.controller.signal)
        .then(() => {
          if (!pending.controller.signal.aborted) waitForRowMap();
        })
        .catch((error: unknown) => {
          // A target that already landed some other way (an older-history
          // backfill committed it) is not a failed jump.
          if (pending.controller.signal.aborted || pending.stage !== "resolving") return;
          settle(
            pending,
            error instanceof TimelineAnchorUnavailableError ? "unavailable" : "failed",
          );
        });
      return id;
    },
    [cancel, listRef, place, settle, threadId],
  );

  /**
   * Re-issues the last request under a fresh id. Callers that keyed state on
   * the old id (the active find match) move it to `id`.
   */
  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last) return null;
    return { previousId: last.id, id: navigate(last.entryId, last.options) };
  }, [navigate]);

  /**
   * Withdraws request `id` (a closed find, or a replaced query): aborts it if it
   * is still pending, or clears the failure it reported so neither the banner
   * nor Retry outlives it. Newer requests are left alone.
   */
  const cancelRequest = useCallback(
    (id: number) => {
      if (pendingRef.current?.id === id || statusOwnerRef.current === id) cancel();
      if (lastRequestRef.current?.id === id && pendingRef.current === null) {
        lastRequestRef.current = null;
      }
    },
    [cancel],
  );

  /**
   * The timeline committed a new row map; a waiting target may now resolve. The
   * jump waits a frame so the list lays out (and re-anchors) the new rows first.
   */
  const handleRowMapCommit = useCallback(() => {
    const pending = pendingRef.current;
    if (pending?.stage !== "resolving" || !entryRowIndexMapRef.current?.has(pending.entryId)) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (pendingRef.current === pending && pending.stage === "resolving") place(pending);
    });
  }, [entryRowIndexMapRef, place]);

  /**
   * A find row highlighted its active match for `requestId`. It is placed once
   * the row has settled; a row that reports early is placed when it does.
   */
  const handleSelectedRange = useCallback(
    (requestId: number, range: Range) => {
      const pending = pendingRef.current;
      if (pending?.id !== requestId || !pending.options.placeRange) return;
      pending.range = range;
      if (pending.stage === "awaiting-range") placeRange(pending);
    },
    [placeRange],
  );

  // A followed new turn wins over a pending jump.
  const followedNonceRef = useRef(followNextTailNonce);
  useLayoutEffect(() => {
    if (followedNonceRef.current === followNextTailNonce) return;
    followedNonceRef.current = followNextTailNonce;
    cancel();
  }, [cancel, followNextTailNonce]);

  // Thread changes and unmount abort whatever is pending.
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      pending.controller.abort();
      pending.detachInput();
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      if (pending.frame !== null) window.cancelAnimationFrame(pending.frame);
      lastRequestRef.current = null;
    },
    [threadId],
  );

  return {
    status,
    navigate,
    cancel,
    cancelRequest,
    retry,
    handleRowMapCommit,
    handleSelectedRange,
  };
}
