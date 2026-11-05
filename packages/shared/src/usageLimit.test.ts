import { describe, expect, it } from "vitest";
import {
  canResumeAtUsageReset,
  claudeQuotaWindowDurationMinutes,
  quotaPace,
  quotaPaceLabel,
  USAGE_RESUME_MAX_HORIZON_MS,
} from "./usageLimit";

describe("canResumeAtUsageReset", () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z");

  it("allows a reset whose buffered continue fits the scheduling horizon", () => {
    expect(canResumeAtUsageReset("2026-10-01T05:00:00.000Z", now)).toBe(true);
    expect(canResumeAtUsageReset("2026-09-30T00:00:00.000Z", now)).toBe(true);
    const lastSchedulable = new Date(now + USAGE_RESUME_MAX_HORIZON_MS - 60_000).toISOString();
    expect(canResumeAtUsageReset(lastSchedulable, now)).toBe(true);
  });

  it("rejects a monthly reset past the horizon and an invalid reset", () => {
    const justPast = new Date(now + USAGE_RESUME_MAX_HORIZON_MS - 59_999).toISOString();
    expect(canResumeAtUsageReset(justPast, now)).toBe(false);
    expect(canResumeAtUsageReset("2026-11-01T00:00:00.000Z", now)).toBe(false);
    expect(canResumeAtUsageReset("not a date", now)).toBe(false);
  });
});

describe("claudeQuotaWindowDurationMinutes", () => {
  it("maps the 5-hour and every seven_day key, and nothing else", () => {
    expect(claudeQuotaWindowDurationMinutes("five_hour")).toBe(300);
    expect(claudeQuotaWindowDurationMinutes("seven_day")).toBe(10_080);
    expect(claudeQuotaWindowDurationMinutes("seven_day_opus")).toBe(10_080);
    expect(claudeQuotaWindowDurationMinutes("monthly_spend")).toBeNull();
    expect(claudeQuotaWindowDurationMinutes("something_new")).toBeNull();
  });
});

describe("quotaPace", () => {
  const observedAt = "2026-11-05T10:20:00.000Z";
  // Weekly window with 18h40m left: 149h20m of 168h elapsed, about 88.9%.
  const weeklyReset = "2026-11-06T05:00:00.000Z";

  it("reads a 2-point gap as on pace", () => {
    const pace = quotaPace({
      usedPercent: 91,
      resetsAt: weeklyReset,
      durationMinutes: 10_080,
      observedAt,
    })!;
    expect(pace.elapsedPercent).toBeCloseTo(88.89, 1);
    expect(quotaPaceLabel(pace)).toBe("on pace");
  });

  it("labels usage ahead of and under the clock", () => {
    // Half of a 5-hour window elapsed.
    const resetsAt = "2026-11-05T12:50:00.000Z";
    const ahead = quotaPace({ usedPercent: 70, resetsAt, durationMinutes: 300, observedAt })!;
    expect(ahead.elapsedPercent).toBe(50);
    expect(ahead.deltaPoints).toBe(20);
    expect(quotaPaceLabel(ahead)).toBe("20 pts ahead of pace");
    const under = quotaPace({ usedPercent: 10, resetsAt, durationMinutes: 300, observedAt })!;
    expect(quotaPaceLabel(under)).toBe("40 pts under pace");
  });

  it("is null without a duration, reset, observation, or utilization", () => {
    const base = { usedPercent: 50, resetsAt: weeklyReset, durationMinutes: 10_080, observedAt };
    expect(quotaPace({ ...base, durationMinutes: null })).toBeNull();
    expect(quotaPace({ ...base, resetsAt: null })).toBeNull();
    expect(quotaPace({ ...base, observedAt: null })).toBeNull();
    expect(quotaPace({ ...base, usedPercent: null })).toBeNull();
  });

  it("is null once the reset is at or before the observation", () => {
    expect(
      quotaPace({ usedPercent: 50, resetsAt: observedAt, durationMinutes: 300, observedAt }),
    ).toBeNull();
  });

  it("clamps elapsed time when the reset is further out than the window", () => {
    const pace = quotaPace({
      usedPercent: 0,
      resetsAt: "2026-11-15T10:20:00.000Z",
      durationMinutes: 300,
      observedAt,
    })!;
    expect(pace.elapsedPercent).toBe(0);
  });
});
