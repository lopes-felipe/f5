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
  const top = node.getBoundingClientRect().top;
  const first = Array.from(node.querySelectorAll<HTMLElement>("[data-timeline-row-id]")).find(
    (row) => row.getBoundingClientRect().bottom > top,
  );
  return {
    rowId: first?.dataset.timelineRowId ?? null,
    top: first ? first.getBoundingClientRect().top - top : 0,
    scroll: node.scrollTop,
    atEnd:
      node.scrollHeight - node.scrollTop - node.clientHeight < Math.max(2, node.clientHeight * 0.1),
  };
}
