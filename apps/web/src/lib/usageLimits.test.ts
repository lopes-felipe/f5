import { describe, expect, it } from "vitest";
import {
  formatTimeUntil,
  formatUsageLimitActivityLabel,
  formatUsageResumeTime,
} from "./usageLimits";

describe("formatTimeUntil", () => {
  const now = Date.parse("2026-10-08T16:30:00.000Z");
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("formats hours and minutes", () => {
    expect(formatTimeUntil(at(99.5), now)).toBe("in 1h 39m");
    expect(formatTimeUntil(at(120), now)).toBe("in 2h 0m");
  });

  it("formats minutes and the final minute", () => {
    expect(formatTimeUntil(at(12), now)).toBe("in 12m");
    expect(formatTimeUntil(at(0.5), now)).toBe("in <1m");
  });

  it("returns null once the time has passed or is invalid", () => {
    expect(formatTimeUntil(at(0), now)).toBeNull();
    expect(formatTimeUntil(at(-5), now)).toBeNull();
    expect(formatTimeUntil("not a date", now)).toBeNull();
  });
});

describe("formatUsageLimitActivityLabel", () => {
  it("includes the window and local reset time", () => {
    const resetsAt = "2026-10-08T18:10:00.000Z";
    expect(
      formatUsageLimitActivityLabel({ providerLabel: "Claude", windowLabel: "5-hour", resetsAt }),
    ).toBe(`Claude 5-hour limit reached · resets ${formatUsageResumeTime(resetsAt)}`);
  });

  it("falls back to a generic usage limit without a window or reset", () => {
    expect(
      formatUsageLimitActivityLabel({ providerLabel: "Codex", windowLabel: null, resetsAt: null }),
    ).toBe("Codex usage limit reached");
  });
});
