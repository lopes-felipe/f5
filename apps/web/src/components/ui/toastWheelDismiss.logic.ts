/**
 * Two-finger horizontal trackpad scroll over a toast, like dismissing a macOS notification
 * banner: the toast follows the fingers toward its screen edge and is dismissed past a
 * threshold; a short swipe snaps back, and a swipe away from the edge only rubber-bands.
 *
 * Fed one wheel event at a time. Browsers report no gesture end, so the caller ends a gesture
 * after `TOAST_WHEEL_IDLE_MS` without events.
 */

/** Movement needed before the gesture picks an axis; first events are often diagonal. */
export const TOAST_WHEEL_AXIS_LOCK_DISTANCE = 8;
/** The share of the toast's width an outward swipe needs to dismiss it. */
export const TOAST_WHEEL_DISMISS_RATIO = 0.35;
/** Movement away from the edge is followed at this rate, up to the cap. */
export const TOAST_WHEEL_RUBBER_BAND = 0.2;
export const TOAST_WHEEL_RUBBER_BAND_MAX = 16;
/** A gesture ends after this long without wheel events; momentum keeps it alive. */
export const TOAST_WHEEL_IDLE_MS = 140;

/** Which way is out: toward the stack's screen edge, or either way for a centered stack. */
export type ToastWheelOutward = "right" | "left" | "either";

export type ToastWheelState =
  | { readonly kind: "pending"; readonly sumX: number; readonly sumY: number }
  | { readonly kind: "tracking"; readonly sumX: number }
  /** Not a horizontal swipe, or one already dismissed: its remaining events are swallowed. */
  | { readonly kind: "ignored" }
  | { readonly kind: "dismissed"; readonly direction: "left" | "right" };

export interface ToastWheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}

export interface ToastWheelStep {
  readonly state: ToastWheelState;
  /** Where the toast is drawn, in px; positive is to the right. */
  readonly offset: number;
  /** The toast should leave now, in this direction. */
  readonly dismiss: "left" | "right" | null;
  /** The event belongs to this gesture; the caller should stop the page handling it. */
  readonly handled: boolean;
}

const DOM_DELTA_PIXEL = 0;

export const INITIAL_TOAST_WHEEL_STATE: ToastWheelState = { kind: "pending", sumX: 0, sumY: 0 };

/** The drawn offset for a raw finger offset: 1:1 outward, rubber-banded inward. */
export function resolveToastWheelOffset(raw: number, outward: ToastWheelOutward): number {
  const isOutward = outward === "either" || (outward === "right" ? raw >= 0 : raw <= 0);
  if (isOutward) return raw;
  const damped = Math.min(TOAST_WHEEL_RUBBER_BAND_MAX, Math.abs(raw) * TOAST_WHEEL_RUBBER_BAND);
  return Math.sign(raw) * damped;
}

export function stepToastWheel(
  state: ToastWheelState,
  event: ToastWheelInput,
  options: { readonly width: number; readonly outward: ToastWheelOutward },
): ToastWheelStep {
  if (state.kind === "ignored") return { state, offset: 0, dismiss: null, handled: false };
  if (state.kind === "dismissed") {
    // The rest of a dismissing swipe, momentum included, must not reach the next toast.
    return { state, offset: 0, dismiss: null, handled: true };
  }
  if (state.kind === "pending") {
    // Pinch-zoom arrives as ctrl+wheel; line and page deltas come from mouse wheels.
    if (event.ctrlKey || event.deltaMode !== DOM_DELTA_PIXEL) {
      return { state: { kind: "ignored" }, offset: 0, dismiss: null, handled: false };
    }
    const sumX = state.sumX + event.deltaX;
    const sumY = state.sumY + event.deltaY;
    if (Math.abs(sumX) + Math.abs(sumY) < TOAST_WHEEL_AXIS_LOCK_DISTANCE) {
      return { state: { kind: "pending", sumX, sumY }, offset: 0, dismiss: null, handled: false };
    }
    if (Math.abs(sumX) <= Math.abs(sumY)) {
      return { state: { kind: "ignored" }, offset: 0, dismiss: null, handled: false };
    }
    return track(sumX, options);
  }
  return track(state.sumX + event.deltaX, options);
}

function track(
  sumX: number,
  options: { readonly width: number; readonly outward: ToastWheelOutward },
): ToastWheelStep {
  // The toast follows the fingers: with natural scrolling, fingers moving right give deltaX < 0.
  const offset = resolveToastWheelOffset(-sumX, options.outward);
  const threshold = Math.max(1, options.width * TOAST_WHEEL_DISMISS_RATIO);
  const outwardOffset =
    options.outward === "either"
      ? Math.abs(offset)
      : options.outward === "right"
        ? offset
        : -offset;
  if (outwardOffset >= threshold) {
    const direction = offset >= 0 ? "right" : "left";
    return { state: { kind: "dismissed", direction }, offset, dismiss: direction, handled: true };
  }
  return { state: { kind: "tracking", sumX }, offset, dismiss: null, handled: true };
}

/** How far out the toast has gone, 0 to 1, for fading it as it leaves. */
export function toastWheelProgress(
  offset: number,
  width: number,
  outward: ToastWheelOutward,
): number {
  const threshold = Math.max(1, width * TOAST_WHEEL_DISMISS_RATIO);
  const outwardOffset =
    outward === "either" ? Math.abs(offset) : outward === "right" ? offset : -offset;
  return Math.max(0, Math.min(1, outwardOffset / threshold));
}
