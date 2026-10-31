export interface TimelineWheelDelta {
  readonly x: number;
  readonly y: number;
  /** `WheelEvent.deltaMode`: pixels, lines or pages. */
  readonly mode: 0 | 1 | 2;
}

/**
 * Replays a wheel on the timeline as a cancelable pixel wheel, so its own
 * listeners (such as the one that stops following the tail) still see it,
 * then scrolls the timeline unless one of them cancelled.
 */
export function replayWheelOnTimeline(
  delta: TimelineWheelDelta,
  timeline: HTMLElement,
  options: {
    readonly maxPixels?: number;
    readonly init?: Omit<WheelEventInit, "deltaX" | "deltaY" | "deltaMode">;
  } = {},
): void {
  const toPixels = (value: number, page: number) => {
    const pixels = value * (delta.mode === 1 ? 16 : delta.mode === 2 ? page : 1);
    const limit = options.maxPixels ?? Infinity;
    return Math.max(-limit, Math.min(limit, pixels));
  };
  const left = toPixels(delta.x, timeline.clientWidth);
  const top = toPixels(delta.y, timeline.clientHeight);
  const replayed = new WheelEvent("wheel", {
    ...options.init,
    bubbles: true,
    cancelable: true,
    deltaX: left,
    deltaY: top,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
  });
  if (!timeline.dispatchEvent(replayed)) return;
  timeline.scrollBy({ left, top });
}

/**
 * The minimap and turn rail float over the timeline as siblings of its scroll container,
 * so a wheel over them would otherwise scroll nothing. Replay the vertical wheel on the
 * timeline instead.
 */
export function forwardWheelToTimeline(event: WheelEvent, timeline: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  replayWheelOnTimeline(
    { x: 0, y: event.deltaY, mode: event.deltaMode as TimelineWheelDelta["mode"] },
    timeline,
    {
      init: {
        deltaZ: event.deltaZ,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    },
  );
}
