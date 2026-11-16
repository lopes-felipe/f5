import { describe, expect, it } from "vitest";

import { projectQuota } from "./usageQuotaProjection";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

describe("projectQuota", () => {
  it("returns null without utilization, a future reset, or a fresh observation", () => {
    const base = { samples: [], now };
    expect(
      projectQuota({ ...base, current: { at: at(0), usedPercent: null }, resetsAt: at(60) }),
    ).toBeNull();
    expect(
      projectQuota({ ...base, current: { at: at(0), usedPercent: 10 }, resetsAt: null }),
    ).toBeNull();
    expect(
      projectQuota({ ...base, current: { at: at(0), usedPercent: 10 }, resetsAt: at(-1) }),
    ).toBeNull();
    expect(
      projectQuota({ ...base, current: { at: at(-31), usedPercent: 10 }, resetsAt: at(60) }),
    ).toBeNull();
  });

  it("reports exhausted and insufficient history", () => {
    expect(
      projectQuota({
        samples: [],
        current: { at: at(0), usedPercent: 100 },
        resetsAt: at(60),
        now,
      }),
    ).toEqual({ kind: "exhausted" });
    // One sample plus the same snapshot is a single observation.
    expect(
      projectQuota({
        samples: [{ at: at(0), usedPercent: 20 }],
        current: { at: at(0), usedPercent: 20 },
        resetsAt: at(60),
        now,
      }),
    ).toEqual({ kind: "insufficient" });
    expect(
      projectQuota({
        samples: [{ at: at(-10), usedPercent: 18 }],
        current: { at: at(0), usedPercent: 20 },
        resetsAt: at(60),
        now,
      }),
    ).toEqual({ kind: "insufficient" });
  });

  it("predicts hitting the limit before reset", () => {
    const projection = projectQuota({
      samples: [
        { at: at(-60), usedPercent: 40 },
        { at: at(-30), usedPercent: 50 },
      ],
      current: { at: at(0), usedPercent: 60 },
      resetsAt: at(300),
      now,
    });
    expect(projection).toEqual({ kind: "will-hit", at: at(120) });
  });

  it("projects usage at reset, clamping negative slopes and capping at 100", () => {
    expect(
      projectQuota({
        samples: [{ at: at(-60), usedPercent: 30 }],
        current: { at: at(0), usedPercent: 30.5 },
        resetsAt: at(60),
        now,
      }),
    ).toEqual({ kind: "under", percentAtReset: 31 });
    // A small decline (within jitter) clamps to a flat projection.
    expect(
      projectQuota({
        samples: [{ at: at(-60), usedPercent: 30.8 }],
        current: { at: at(0), usedPercent: 30 },
        resetsAt: at(60),
        now,
      }),
    ).toEqual({ kind: "under", percentAtReset: 30 });
  });

  it("drops history when current usage fell below it (a reset)", () => {
    expect(
      projectQuota({
        samples: [
          { at: at(-60), usedPercent: 80 },
          { at: at(-30), usedPercent: 90 },
        ],
        current: { at: at(0), usedPercent: 5 },
        resetsAt: at(300),
        now,
      }),
    ).toEqual({ kind: "insufficient" });
  });

  it("uses a 2-hour lookback near reset and 24 hours otherwise", () => {
    const samples = [
      { at: at(-180), usedPercent: 0 },
      { at: at(-60), usedPercent: 50 },
    ];
    // Near reset: the 3-hour-old sample is outside the lookback.
    expect(
      projectQuota({ samples, current: { at: at(0), usedPercent: 50 }, resetsAt: at(300), now }),
    ).toEqual({ kind: "under", percentAtReset: 50 });
    // Far from reset: all three observations count, so the slope is positive.
    const far = projectQuota({
      samples,
      current: { at: at(0), usedPercent: 50 },
      resetsAt: at(60 * 48),
      now,
    });
    expect(far?.kind).toBe("will-hit");
  });
});
