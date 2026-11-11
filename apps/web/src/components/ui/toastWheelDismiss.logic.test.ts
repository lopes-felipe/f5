import { describe, expect, it } from "vitest";

import {
  INITIAL_TOAST_WHEEL_STATE,
  stepToastWheel,
  TOAST_WHEEL_RUBBER_BAND_MAX,
  toastWheelProgress,
  type ToastWheelOutward,
  type ToastWheelState,
  type ToastWheelStep,
} from "./toastWheelDismiss.logic";

const WIDTH = 344;
const THRESHOLD = WIDTH * 0.35;

function wheel(
  deltaX: number,
  deltaY = 0,
  overrides: { deltaMode?: number; ctrlKey?: boolean } = {},
) {
  return {
    deltaX,
    deltaY,
    deltaMode: overrides.deltaMode ?? 0,
    ctrlKey: overrides.ctrlKey ?? false,
  };
}

/** Feeds a sequence of wheel events and returns every step. */
function run(
  events: ReturnType<typeof wheel>[],
  outward: ToastWheelOutward = "right",
): ToastWheelStep[] {
  let state: ToastWheelState = INITIAL_TOAST_WHEEL_STATE;
  return events.map((event) => {
    const step = stepToastWheel(state, event, { width: WIDTH, outward });
    state = step.state;
    return step;
  });
}

describe("stepToastWheel", () => {
  it("ignores vertical-dominant gestures", () => {
    const steps = run([wheel(1, 4), wheel(3, 10), wheel(-40, 0)]);
    expect(steps.map((step) => step.state.kind)).toEqual(["pending", "ignored", "ignored"]);
    expect(steps.every((step) => !step.handled && step.offset === 0)).toBe(true);
  });

  it("follows an outward swipe 1:1, with fingers moving right giving negative deltaX", () => {
    const steps = run([wheel(-5), wheel(-5), wheel(-20)]);
    expect(steps.at(-1)).toMatchObject({ offset: 30, dismiss: null, handled: true });
    expect(steps.at(-1)!.state.kind).toBe("tracking");
  });

  it("rubber-bands an inward swipe and caps it", () => {
    expect(run([wheel(10), wheel(20)]).at(-1)!.offset).toBeCloseTo(-6);
    expect(run([wheel(10), wheel(400)]).at(-1)!.offset).toBe(-TOAST_WHEEL_RUBBER_BAND_MAX);
    expect(run([wheel(10), wheel(400)]).at(-1)!.dismiss).toBe(null);
  });

  it("dismisses at 35% of the width and swallows the rest of the gesture", () => {
    const steps = run([wheel(-10), wheel(-(THRESHOLD - 11)), wheel(-2), wheel(-30), wheel(0, -40)]);
    expect(steps[1]!.dismiss).toBe(null);
    expect(steps[2]!.dismiss).toBe("right");
    expect(steps.slice(3).map((step) => [step.state.kind, step.dismiss, step.handled])).toEqual([
      ["dismissed", null, true],
      ["dismissed", null, true],
    ]);
  });

  it("dismisses to the left for a left-hand stack, and either way when centered", () => {
    expect(run([wheel(10), wheel(THRESHOLD)], "left").at(-1)!.dismiss).toBe("left");
    expect(run([wheel(-10), wheel(-THRESHOLD)], "left").at(-1)!.dismiss).toBe(null);
    expect(run([wheel(10), wheel(THRESHOLD)], "either").at(-1)!.dismiss).toBe("left");
    expect(run([wheel(-10), wheel(-THRESHOLD)], "either").at(-1)!.dismiss).toBe("right");
  });

  it("ignores pinch-zoom and line or page wheels", () => {
    expect(run([wheel(-50, 0, { ctrlKey: true })])[0]!.state.kind).toBe("ignored");
    expect(run([wheel(-50, 0, { deltaMode: 1 })])[0]!.state.kind).toBe("ignored");
  });
});

describe("toastWheelProgress", () => {
  it("counts only outward movement toward the threshold", () => {
    expect(toastWheelProgress(THRESHOLD / 2, WIDTH, "right")).toBeCloseTo(0.5);
    expect(toastWheelProgress(-10, WIDTH, "right")).toBe(0);
    expect(toastWheelProgress(THRESHOLD * 2, WIDTH, "right")).toBe(1);
  });
});
