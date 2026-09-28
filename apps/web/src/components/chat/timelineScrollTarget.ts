/** Let nested code/output panes consume scrolling before moving the conversation. */
export function shouldScrollTimeline(
  target: EventTarget | null,
  timeline: HTMLElement,
  direction: number,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== timeline) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY)) {
        const canScroll =
          direction < 0
            ? node.scrollTop > 0
            : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
        if (canScroll || /^(contain|none)$/.test(style.overscrollBehaviorY)) return false;
      }
    }
    node = node.parentElement;
  }
  return true;
}
