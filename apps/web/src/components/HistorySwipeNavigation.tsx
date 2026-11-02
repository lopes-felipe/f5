import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isModalDialogOpen } from "~/lib/modalDialogs";
import { cn } from "~/lib/utils";
import { canNavigateHistory, navigateHistory, type HistoryDirection } from "~/navigationHistory";

const SWIPE_TRIGGER_DISTANCE = 120;
// Movement needed before the gesture picks an axis; first events are often diagonal.
const SWIPE_AXIS_LOCK_DISTANCE = 8;
const MOMENTUM_SAMPLE_SIZE = 5;
// Popovers are non-modal dialogs; a swipe over one is not page navigation either.
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

type SwipeBounds = { left: number; top: number; width: number; height: number };
// `distanceBefore` lets a momentum tail be taken back out once it is recognized.
type SwipeSample = { delta: number; distanceBefore: number };
type SwipeGesture =
  | { kind: "pending"; path: readonly EventTarget[]; y: number; sumX: number; sumY: number }
  | {
      kind: "tracking";
      direction: HistoryDirection;
      distance: number;
      samples: SwipeSample[];
      y: number;
      bounds: SwipeBounds;
    }
  // Not a swipe, or one already decided: the rest of its events are ignored.
  | { kind: "ignored" };
type SwipeIndicatorState = {
  direction: HistoryDirection;
  progress: number;
  y: number;
  bounds: SwipeBounds;
  tracking: boolean;
};

// Everything right of the thread sidebar; the gap is 0 wide while it is collapsed.
function readMainContentBounds(): SwipeBounds {
  const gap = document.querySelector(
    '[data-thread-sidebar-layout="true"] [data-slot="sidebar"][data-side="left"] > [data-slot="sidebar-gap"]',
  );
  const left = Math.max(0, gap?.getBoundingClientRect().right ?? 0);
  return { left, top: 0, width: Math.max(0, window.innerWidth - left), height: window.innerHeight };
}

// The composed path reaches scrollers inside shadow roots, such as rendered diffs.
function canScrollHorizontally(path: readonly EventTarget[], deltaX: number): boolean {
  for (const element of path) {
    if (!(element instanceof Element) || element.scrollWidth <= element.clientWidth) continue;
    const { overflowX } = getComputedStyle(element);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    const canScroll =
      deltaX < 0
        ? element.scrollLeft > 0
        : element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    if (canScroll) return true;
  }
  return false;
}

function lockSwipeAxis(
  pending: Extract<SwipeGesture, { kind: "pending" }>,
): Exclude<SwipeGesture, { kind: "pending" }> {
  const { path, sumX, sumY } = pending;
  if (Math.abs(sumX) <= Math.abs(sumY)) return { kind: "ignored" };
  // A modal's backdrop sits outside the dialog element, so any open modal blocks the swipe.
  if (isModalDialogOpen()) return { kind: "ignored" };
  if (path.some((element) => element instanceof Element && element.matches(DIALOG_SELECTOR))) {
    return { kind: "ignored" };
  }
  if (canScrollHorizontally(path, sumX)) return { kind: "ignored" };
  const direction = sumX < 0 ? "back" : "forward";
  if (!canNavigateHistory(direction)) return { kind: "ignored" };
  return {
    kind: "tracking",
    direction,
    distance: Math.abs(sumX),
    samples: [],
    y: pending.y,
    bounds: readMainContentBounds(),
  };
}

/**
 * macOS momentum after the fingers lift decays by a near-constant ratio per
 * event; finger movement is noisier. Deltas are signed along the swipe.
 */
export function isMomentumTail(deltas: readonly number[]): boolean {
  if (deltas.length < MOMENTUM_SAMPLE_SIZE) return false;
  const recent = deltas.slice(-MOMENTUM_SAMPLE_SIZE);
  if (recent.some((delta) => delta <= 0)) return false;
  const ratios = recent.slice(1).map((delta, index) => delta / recent[index]!);
  return (
    ratios.every((ratio) => ratio >= 0.7 && ratio < 1) &&
    Math.max(...ratios) - Math.min(...ratios) < 0.1
  );
}

/**
 * Two-finger horizontal trackpad swipes go back and forward, like a browser.
 * macOS desktop only: it relies on the main process bracketing each scroll.
 */
export function HistorySwipeNavigation() {
  const router = useRouter();
  const [swipe, setSwipe] = useState<SwipeIndicatorState | null>(null);

  useEffect(() => {
    const onTrackpadScroll = window.desktopBridge?.onTrackpadScroll;
    if (typeof onTrackpadScroll !== "function") return;
    let gesture: SwipeGesture | null = null;
    const hideIndicator = () =>
      setSwipe((current) => (current === null ? null : { ...current, tracking: false }));
    // The fingers lifted: navigate if the swipe went far enough, then ignore its momentum.
    const release = () => {
      if (gesture?.kind === "tracking" && gesture.distance >= SWIPE_TRIGGER_DISTANCE) {
        navigateHistory(router.history, gesture.direction);
      }
      gesture = { kind: "ignored" };
      hideIndicator();
    };
    // Chromium brackets each scroll, momentum included, with these. The begin can arrive
    // after the scroll's first wheel event, so it may find a gesture already pending.
    const unsubscribe = onTrackpadScroll((event) => {
      if (event.phase === "begin") {
        if (event.precise === false) {
          // A mouse wheel, not a trackpad: ignore this scroll entirely.
          if (gesture?.kind === "tracking") hideIndicator();
          gesture = { kind: "ignored" };
        } else if (gesture?.kind === "ignored") {
          gesture = null;
        }
        return;
      }
      if (gesture?.kind === "tracking") release();
      gesture = null;
    });
    const onWheel = (event: WheelEvent) => {
      if (gesture === null) {
        gesture =
          event.ctrlKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL
            ? { kind: "ignored" }
            : { kind: "pending", path: event.composedPath(), y: event.clientY, sumX: 0, sumY: 0 };
      }
      if (gesture.kind === "ignored") return;
      if (gesture.kind === "pending") {
        gesture.sumX += event.deltaX;
        gesture.sumY += event.deltaY;
        if (Math.abs(gesture.sumX) + Math.abs(gesture.sumY) < SWIPE_AXIS_LOCK_DISTANCE) return;
        gesture = lockSwipeAxis(gesture);
        if (gesture.kind === "ignored") return;
      } else {
        const delta = gesture.direction === "back" ? -event.deltaX : event.deltaX;
        if (event.deltaX === 0 && event.deltaY === 0) return release();
        gesture.samples = [
          ...gesture.samples.slice(1 - MOMENTUM_SAMPLE_SIZE),
          { delta, distanceBefore: gesture.distance },
        ];
        if (isMomentumTail(gesture.samples.map((sample) => sample.delta))) {
          // The fingers lifted before the tail's first sample; momentum does not count.
          gesture.distance = gesture.samples[0]!.distanceBefore;
          return release();
        }
        gesture.distance = Math.max(0, gesture.distance + delta);
      }
      setSwipe({
        direction: gesture.direction,
        progress: Math.min(1, gesture.distance / SWIPE_TRIGGER_DISTANCE),
        y: gesture.y,
        bounds: gesture.bounds,
        tracking: true,
      });
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      unsubscribe();
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [router]);

  return swipe === null ? null : <SwipeIndicator {...swipe} />;
}

// A circle pinned to the edge of the main content that peeks in up to half its width.
function SwipeIndicator({ direction, progress, y, bounds, tracking }: SwipeIndicatorState) {
  const armed = progress >= 1;
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  const hidden = 100 - progress * 50;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-100 overflow-hidden"
      style={bounds}
    >
      <div
        className={cn(
          "absolute flex size-14 items-center rounded-full bg-muted text-foreground dark:bg-black dark:text-white",
          direction === "back" ? "left-0 justify-end pr-2" : "right-0 justify-start pl-2",
          !tracking && "transition-[opacity,transform] duration-200 ease-out",
        )}
        style={{
          top: `clamp(0px, calc(${y - bounds.top}px - 1.75rem), calc(100% - 3.5rem))`,
          opacity: tracking ? 1 : 0,
          transform: `translateX(${direction === "back" ? -hidden : hidden}%)`,
        }}
      >
        <Icon
          className={cn(
            "size-4 transition-opacity duration-100",
            armed ? "opacity-100" : "opacity-40",
          )}
        />
      </div>
    </div>
  );
}
