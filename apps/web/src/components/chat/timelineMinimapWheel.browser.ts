import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardWheelToTimeline, replayWheelOnTimeline } from "./timelineMinimapWheel";

function setup() {
  const timeline = document.createElement("div");
  const minimap = document.createElement("div");
  Object.defineProperty(timeline, "clientHeight", { value: 500 });
  Object.defineProperty(timeline, "clientWidth", { value: 800 });
  const scrollBy = vi.fn();
  timeline.scrollBy = scrollBy as typeof timeline.scrollBy;
  const seen: WheelEvent[] = [];
  timeline.addEventListener("wheel", (event) => seen.push(event));
  minimap.addEventListener("wheel", (event) => forwardWheelToTimeline(event, timeline));
  document.body.append(timeline, minimap);
  const wheel = (init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    minimap.dispatchEvent(event);
    return event;
  };
  return { timeline, scrollBy, seen, wheel };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("forwardWheelToTimeline", () => {
  it("replays the wheel on the timeline and scrolls it instead of the minimap", () => {
    const { timeline, scrollBy, seen, wheel } = setup();
    const original = wheel({ deltaY: -120, clientX: 20, clientY: 300 });

    expect(original.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toBe(timeline);
    expect(seen[0]?.deltaY).toBe(-120);
    expect(seen[0]?.clientY).toBe(300);
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: -120 });
  });

  it.each([
    { deltaMode: WheelEvent.DOM_DELTA_LINE, top: 48 },
    { deltaMode: WheelEvent.DOM_DELTA_PAGE, top: 1500 },
  ])("converts delta mode $deltaMode to pixels", ({ deltaMode, top }) => {
    const { scrollBy, wheel } = setup();
    wheel({ deltaY: 3, deltaMode });
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top });
  });

  it("lets a timeline listener cancel the scroll", () => {
    const { timeline, scrollBy, wheel } = setup();
    timeline.addEventListener("wheel", (event) => event.preventDefault());
    wheel({ deltaY: 40 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it.each([{ deltaY: 40, ctrlKey: true }, { deltaX: 40 }])(
    "leaves pinch zoom and horizontal wheels alone: %j",
    (init) => {
      const { scrollBy, seen, wheel } = setup();
      expect(wheel(init).defaultPrevented).toBe(false);
      expect(seen).toHaveLength(0);
      expect(scrollBy).not.toHaveBeenCalled();
    },
  );
});

describe("replayWheelOnTimeline", () => {
  it("replays pixel deltas, keeps horizontal movement and clamps each axis", () => {
    const { timeline, scrollBy, seen } = setup();
    replayWheelOnTimeline({ x: 30, y: 2, mode: 2 }, timeline, { maxPixels: 1000 });
    expect(seen[0]).toMatchObject({ deltaX: 1000, deltaY: 1000, deltaMode: 0 });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 1000, top: 1000 });
    replayWheelOnTimeline({ x: -2, y: -3, mode: 1 }, timeline, { maxPixels: 1000 });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -32, top: -48 });
    replayWheelOnTimeline({ x: 5, y: -5000, mode: 0 }, timeline, { maxPixels: 1000 });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 5, top: -1000 });
  });

  it("does not scroll when a timeline listener cancels the replay", () => {
    const { timeline, scrollBy } = setup();
    timeline.addEventListener("wheel", (event) => event.preventDefault());
    replayWheelOnTimeline({ x: 0, y: 40, mode: 0 }, timeline);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
