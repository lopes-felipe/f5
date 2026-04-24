import { describe, expect, it } from "vitest";

import {
  SMART_RESUME_IDLE_THRESHOLD_MS,
  evaluateSmartResume,
  formatAwayDuration,
} from "./lastHomeVisit";

describe("evaluateSmartResume", () => {
  it("returns shouldOffer=false when there is no previous visit", () => {
    expect(evaluateSmartResume(null)).toEqual({ awayMs: 0, shouldOffer: false });
  });

  it("returns shouldOffer=false when the gap is below the threshold", () => {
    const now = Date.now();
    const result = evaluateSmartResume(now - 5 * 60 * 1000, now);
    expect(result.shouldOffer).toBe(false);
  });

  it("returns shouldOffer=true once the gap crosses the threshold", () => {
    const now = Date.now();
    const result = evaluateSmartResume(now - SMART_RESUME_IDLE_THRESHOLD_MS - 1000, now);
    expect(result.shouldOffer).toBe(true);
  });

  it("clamps negative gaps to zero (clock skew)", () => {
    const now = Date.now();
    const result = evaluateSmartResume(now + 5_000, now);
    expect(result.awayMs).toBe(0);
    expect(result.shouldOffer).toBe(false);
  });
});

describe("formatAwayDuration", () => {
  it("renders minutes below an hour", () => {
    expect(formatAwayDuration(45 * 60 * 1000)).toBe("45m");
  });

  it("renders hours below a day", () => {
    expect(formatAwayDuration(3 * 60 * 60 * 1000)).toBe("3h");
  });

  it("renders days above 24h", () => {
    expect(formatAwayDuration(2 * 24 * 60 * 60 * 1000)).toBe("2d");
  });
});
