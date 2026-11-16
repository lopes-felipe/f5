import type { LegendListRef } from "@legendapp/list/react";

export interface TimelineScrollAnchor {
  rowId: string | null;
  top: number;
  scroll: number;
  atEnd: boolean;
}

export function createTimelineScrollAnchors(limit = 50) {
  const anchors = new Map<string, TimelineScrollAnchor>();
  return {
    get(threadId: string): TimelineScrollAnchor | undefined {
      const anchor = anchors.get(threadId);
      if (anchor) {
        anchors.delete(threadId);
        anchors.set(threadId, anchor);
      }
      return anchor;
    },
    set(threadId: string, anchor: TimelineScrollAnchor) {
      anchors.delete(threadId);
      anchors.set(threadId, anchor);
      while (anchors.size > limit) anchors.delete(anchors.keys().next().value!);
    },
  };
}
export const timelineScrollAnchors = createTimelineScrollAnchors();

export function readTimelineScrollAnchor(node: HTMLElement): TimelineScrollAnchor {
  const bounds = node.getBoundingClientRect();
  const top = bounds.top;
  // Virtual rows are recycled in DOM order. Select by visible geometry.
  let first: HTMLElement | undefined;
  let firstTop = Infinity;
  for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > top && rect.top < bounds.bottom && rect.top < firstTop) {
      first = row;
      firstTop = rect.top;
    }
  }
  return {
    rowId: first?.dataset.timelineRowId ?? null,
    top: first ? firstTop - top : 0,
    scroll: node.scrollTop,
    atEnd:
      node.scrollHeight - node.scrollTop - node.clientHeight < Math.max(2, node.clientHeight * 0.1),
  };
}

/** Retain the reader's row even when the virtual list prepends at scroll zero. */
export async function preserveTimelineAnchorDuringHistoryLoad(input: {
  getList: () => LegendListRef | null;
  getRowIndex: (id: string) => number | undefined;
  signal: AbortSignal;
  /** A deliberate jump takes ownership away from a pending history restoration. */
  canRestore?: () => boolean;
  load: () => Promise<void>;
}) {
  const list = input.getList();
  const node = list?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) return input.load();
  if (input.signal.aborted) return;
  const lifetime = new AbortController();
  const cancelRestore = () => lifetime.abort();
  input.signal.addEventListener("abort", cancelRestore, { once: true });
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
    node.addEventListener(type, cancelRestore, { passive: true, signal: lifetime.signal });
  // Remember reaching the tail while the request is pending. A later prepend
  // can move the tail before restoration checks it again.
  node.addEventListener(
    "scroll",
    () => {
      if (
        node.scrollHeight - node.scrollTop - node.clientHeight <
        Math.max(2, node.clientHeight * 0.1)
      )
        cancelRestore();
    },
    { passive: true, signal: lifetime.signal },
  );
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        lifetime.signal.removeEventListener("abort", cancelled);
        resolve();
      };
      const frame = requestAnimationFrame(done);
      const cancelled = () => {
        cancelAnimationFrame(frame);
        done();
      };
      lifetime.signal.addEventListener("abort", cancelled, { once: true });
      if (lifetime.signal.aborted) cancelled();
    });
  const current = () =>
    !lifetime.signal.aborted &&
    (input.canRestore?.() ?? true) &&
    node.isConnected &&
    input.getList() === list &&
    node.scrollHeight - node.scrollTop - node.clientHeight > Math.max(2, node.clientHeight * 0.1);
  try {
    let anchor = readTimelineScrollAnchor(node);
    // Viewability can change before recycled DOM rows finish their commit.
    for (let frame = 0; !anchor.rowId && frame < 2 && !lifetime.signal.aborted; frame++) {
      await nextFrame();
      anchor = readTimelineScrollAnchor(node);
    }
    if (input.signal.aborted) return;
    if (!anchor.rowId || anchor.atEnd || lifetime.signal.aborted) return await input.load();
    window.__f5PerformanceCounters?.historyLoadStarted?.(anchor);
    await input.load();
    // Let React and LegendList finish their own data-position adjustment first.
    await nextFrame();
    await nextFrame();
    if (!current()) return;
    const index = input.getRowIndex(anchor.rowId);
    if (index === undefined) return;
    await list!.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: anchor.top });
    await nextFrame();
    await nextFrame();
    if (!current()) return;
    const row = Array.from(node.querySelectorAll<HTMLElement>("[data-timeline-row-id]")).find(
      (row) => row.dataset.timelineRowId === anchor.rowId,
    );
    if (row)
      node.scrollTop +=
        row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.top;
  } finally {
    lifetime.abort();
    input.signal.removeEventListener("abort", cancelRestore);
  }
}
