import { describe, expect, it } from "vitest";
import { decodeMuseSubscriptionUsage, museUsageLimit } from "./MuseUsageLimits.ts";

const now = Date.parse("2026-10-08T08:00:00Z");
const reset = Date.parse("2026-10-08T13:19:17Z");
const weeklyReset = Date.parse("2026-10-12T00:00:00Z");
const quotaMessage = "API error 429: Subscription quota exhausted.";
const usage = {
  observedAtMs: now,
  tier: "tier-1",
  window: { usedPercent: 103, windowDurationMins: 300, resetsAtMs: reset },
  weekly: { usedPercent: 5, resetsAtMs: weeklyReset },
};

describe("Muse subscription limits", () => {
  it("waits for every exhausted window, ignoring windows with room left", () => {
    expect(museUsageLimit(usage, now, quotaMessage, undefined)?.resetsAt).toBe(
      new Date(reset).toISOString(),
    );
    expect(
      museUsageLimit(
        {
          ...usage,
          weekly: { ...usage.weekly, usedPercent: 100 },
        },
        now,
        quotaMessage,
        undefined,
      )?.resetsAt,
    ).toBe(new Date(weeklyReset).toISOString());
  });
  it("uses typed and relayed message resets, taking the latest future reset", () => {
    expect(museUsageLimit(undefined, now, "Refused", { resetsAtMs: reset })?.resetsAt).toBe(
      new Date(reset).toISOString(),
    );
    const relayed =
      "API error 429: All credentials cooling down (Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.)";
    expect(museUsageLimit(usage, now, relayed, undefined)?.resetsAt).toBe(
      "2026-10-13T10:45:52.000Z",
    );
    expect(
      museUsageLimit(undefined, reset, quotaMessage, { resetsAtMs: reset })?.resetsAt,
    ).toBeNull();
    expect(museUsageLimit(undefined, now, quotaMessage, { resetsAtMs: 1e16 })?.resetsAt).toBeNull();
  });
  it("classifies quotas without a reset but leaves ordinary throttling alone", () => {
    expect(museUsageLimit(undefined, now, quotaMessage, undefined)?.resetsAt).toBeNull();
    expect(
      museUsageLimit(undefined, now, "API error 429: Rate limit exceeded", undefined),
    ).toBeUndefined();
    expect(
      museUsageLimit(undefined, now, "Subscription quota exhausted", undefined),
    ).toBeUndefined();
  });
  it("ignores malformed reports including unformattable dates", () => {
    expect(decodeMuseSubscriptionUsage(usage)).toEqual(usage);
    expect(decodeMuseSubscriptionUsage({ window: "bad" })).toBeUndefined();
    expect(
      decodeMuseSubscriptionUsage({
        ...usage,
        window: { ...usage.window, resetsAtMs: 1e16 },
      }),
    ).toBeUndefined();
  });
});
