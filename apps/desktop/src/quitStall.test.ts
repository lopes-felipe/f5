import { describe, expect, it } from "vitest";

import { QUIT_STALL_THRESHOLD_MS, makeQuitStallTracker } from "./quitStall";

function trackerAt(start = 1_000) {
  let now = start;
  const tracker = makeQuitStallTracker(() => now);
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("makeQuitStallTracker", () => {
  it("swallows a repeat that arrives while shutdown is still within its budget", () => {
    const { tracker, advance } = trackerAt();
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS - 1);

    expect(tracker.check()).toEqual({ kind: "pending", pendingMs: QUIT_STALL_THRESHOLD_MS - 1 });
  });

  it("reports a stall once shutdown has been pending past the threshold", () => {
    const { tracker, advance } = trackerAt();
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS);

    expect(tracker.check()).toEqual({ kind: "stalled", pendingMs: QUIT_STALL_THRESHOLD_MS });
  });

  it("keeps the first start time when a quit begins again while one is pending", () => {
    const { tracker, advance } = trackerAt();
    tracker.begin();
    advance(6_000);
    tracker.begin();
    advance(4_000);

    expect(tracker.check().kind).toBe("stalled");
  });

  it("starts over after a vetoed quit is reset", () => {
    const { tracker, advance } = trackerAt();
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS * 2);
    tracker.reset();
    tracker.begin();
    advance(1_000);

    expect(tracker.check()).toEqual({ kind: "pending", pendingMs: 1_000 });
  });

  it("treats a repeat without a recorded start as the start of the wait", () => {
    const { tracker, advance } = trackerAt();

    expect(tracker.check()).toEqual({ kind: "pending", pendingMs: 0 });
    advance(QUIT_STALL_THRESHOLD_MS);
    expect(tracker.check().kind).toBe("stalled");
  });
});
