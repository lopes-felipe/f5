/**
 * The minimap and turn rail float over the timeline as siblings of its scroll container,
 * so a wheel over them would otherwise scroll nothing. Replay the wheel on the timeline,
 * so its own listeners still see it, then scroll it unless one of them cancelled.
 */
export function forwardWheelToTimeline(event: WheelEvent, timeline: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();

  const forwarded = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    altKey: event.altKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
  if (!timeline.dispatchEvent(forwarded)) return;

  const pixelsPerUnit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? timeline.clientHeight
        : 1;
  timeline.scrollBy({ top: event.deltaY * pixelsPerUnit });
}
