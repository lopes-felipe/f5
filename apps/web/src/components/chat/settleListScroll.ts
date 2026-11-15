/** Correct virtual-list estimates against measured layout, with bounded work. */
export function settleListScroll(
  list: {
    getScrollableNode(): HTMLElement | null;
    scrollToOffset(options: { offset: number; animated: boolean }): Promise<unknown>;
  },
  cancelled: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    // scrollToEnd can resolve after the caller's view has unmounted. LegendList's
    // ref methods dereference its disposed scroller, so check ownership first.
    if (cancelled()) return resolve();
    let frames = 0;
    let stable = 0;
    let interrupted = false;
    let finished = false;
    const viewport = list.getScrollableNode();
    const interrupt = () => {
      interrupted = true;
    };
    const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const event of events) viewport?.addEventListener?.(event, interrupt, { passive: true });
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const event of events) viewport?.removeEventListener?.(event, interrupt);
      resolve();
    };
    const reconcile = () => {
      if (finished) return;
      if (interrupted || cancelled() || frames++ >= 60) return finish();
      const element = list.getScrollableNode();
      if (!element || element !== viewport) return finish();
      const offset = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Math.abs(element.scrollTop - offset) <= 1) {
        if (++stable >= 2) return finish();
        requestAnimationFrame(reconcile);
      } else {
        stable = 0;
        // Virtual lists can leave imperative scroll promises pending while
        // estimates settle. Keep correcting measurements independently.
        try {
          void Promise.resolve(list.scrollToOffset({ offset, animated: false })).catch(finish);
        } catch {
          return finish();
        }
        requestAnimationFrame(reconcile);
      }
    };
    requestAnimationFrame(reconcile);
  });
}
