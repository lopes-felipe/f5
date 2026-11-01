import { describe, expect, it } from "vitest";
import { canResumeAtUsageReset, USAGE_RESUME_MAX_HORIZON_MS } from "./usageLimit";

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
