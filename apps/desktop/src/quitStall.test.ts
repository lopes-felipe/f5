import { describe, expect, it } from "vitest";

import { QUIT_STALL_THRESHOLD_MS, classifyQuitRequest, makeQuitStallTracker } from "./quitStall";

function harness() {
  let now = 1_000;
  const tracker = makeQuitStallTracker(() => now);
  const state = { shutdownComplete: false, updateInstallOwnsQuit: false };
  return {
    tracker,
    state,
    advance: (ms: number) => {
      now += ms;
    },
    classify: () => classifyQuitRequest({ tracker, ...state }),
  };
}

describe("classifyQuitRequest", () => {
  it("begins shutdown on the first request, then swallows repeats within the budget", () => {
    const { tracker, advance, classify } = harness();
    expect(classify()).toEqual({ kind: "begin" });

    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS - 1);
    expect(classify()).toEqual({ kind: "pending", pendingMs: QUIT_STALL_THRESHOLD_MS - 1 });
  });

  it("exits on a repeat once shutdown has been pending past the threshold", () => {
    const { tracker, advance, classify } = harness();
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS);

    expect(classify()).toEqual({ kind: "stalled", pendingMs: QUIT_STALL_THRESHOLD_MS });
  });

  it("keeps the first start time when a quit begins again while one is pending", () => {
    const { tracker, advance, classify } = harness();
    tracker.begin();
    advance(6_000);
    tracker.begin();
    advance(4_000);

    expect(classify().kind).toBe("stalled");
  });

  it("lets shutdown's own final quit through however long shutdown took", () => {
    const { tracker, state, advance, classify } = harness();
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS * 3);
    state.shutdownComplete = true;

    expect(classify()).toEqual({ kind: "complete" });
  });

  it("never exits while the update installer owns the quit", () => {
    const { tracker, state, advance, classify } = harness();
    state.updateInstallOwnsQuit = true;
    expect(classify()).toEqual({ kind: "deferred" });

    // A Dock Quit during install may still start the shutdown clock.
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS * 2);
    expect(classify()).toEqual({ kind: "deferred" });
  });

  it("starts over after a vetoed quit is reset", () => {
    const { tracker, advance, classify } = harness();
    tracker.begin();
    advance(QUIT_STALL_THRESHOLD_MS * 2);
    tracker.reset();
    expect(classify()).toEqual({ kind: "begin" });

    tracker.begin();
    advance(1_000);
    expect(classify()).toEqual({ kind: "pending", pendingMs: 1_000 });
  });
});

describe("makeQuitStallTracker", () => {
  it("reports no pending quit until one begins", () => {
    const tracker = makeQuitStallTracker();
    expect(tracker.pendingMs()).toBeNull();
    tracker.begin();
    expect(tracker.pendingMs()).toBeGreaterThanOrEqual(0);
  });
});
