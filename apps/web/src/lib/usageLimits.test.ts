import type { UsageAccounts } from "@t3tools/contracts";
import { codexRateLimitWindowLabel, quotaWindowsFromSection } from "@t3tools/shared/usageLimit";
import { describe, expect, it } from "vitest";
import {
  formatTimeUntil,
  formatUsageLimitActivityLabel,
  formatUsageLimits,
  formatUsageResumeTime,
} from "./usageLimits";

describe("formatTimeUntil", () => {
  const now = Date.parse("2026-10-08T16:30:00.000Z");
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("formats hours and minutes", () => {
    expect(formatTimeUntil(at(99.5), now)).toBe("in 1h 39m");
    expect(formatTimeUntil(at(120), now)).toBe("in 2h 0m");
  });

  it("formats days and hours from 24 hours", () => {
    expect(formatTimeUntil(at(24 * 60), now)).toBe("in 1d 0h");
    expect(formatTimeUntil(at((5 * 24 + 10) * 60 + 5), now)).toBe("in 5d 10h");
    expect(formatTimeUntil(at(23 * 60 + 59), now)).toBe("in 23h 59m");
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

describe("formatUsageLimits", () => {
  const fetchedAt = "2026-10-08T16:00:00.000Z";
  const codex: UsageAccounts[number] = {
    key: "codex:default",
    provider: "codex",
    providerInstanceId: null,
    displayName: "Codex",
    enabled: true,
    refreshState: "idle",
    sections: [
      {
        kind: "codex-limits",
        outcome: "available",
        lastAttemptAt: fetchedAt,
        errorCode: null,
        snapshot: {
          fetchedAt,
          data: {
            rateLimits: [
              {
                id: "codex",
                name: null,
                planType: null,
                primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
                secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: null },
                credits: null,
              },
              {
                id: "other",
                name: null,
                planType: null,
                primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: null },
                secondary: null,
                credits: null,
              },
            ],
          },
        },
      },
    ],
  };

  it("uses shared window labels and only the main Codex limit", () => {
    expect(formatUsageLimits([codex], Date.parse(fetchedAt) + 60_000)).toBe(
      "Codex: 5-hour limit: 58% remaining, Weekly limit: 90% remaining",
    );
  });

  it("marks snapshots older than 15 minutes", () => {
    const now = Date.parse(fetchedAt) + 16 * 60_000;
    expect(formatUsageLimits([codex], now)).toContain(
      `(as of ${formatUsageResumeTime(fetchedAt, new Date(now))})`,
    );
  });
});

describe("shared quota windows", () => {
  it("labels Codex windows by duration", () => {
    expect(codexRateLimitWindowLabel({ windowDurationMins: 300 }, "x")).toBe("5-hour limit");
    expect(codexRateLimitWindowLabel({ windowDurationMins: 10_080 }, "x")).toBe("Weekly limit");
    expect(codexRateLimitWindowLabel({ windowDurationMins: 2_880 }, "x")).toBe("2-day limit");
    expect(codexRateLimitWindowLabel({ windowDurationMins: 120 }, "x")).toBe("2-hour limit");
    expect(codexRateLimitWindowLabel({ windowDurationMins: 45 }, "x")).toBe("45-minute limit");
    expect(codexRateLimitWindowLabel({ windowDurationMins: null }, "Fallback")).toBe("Fallback");
  });

  it("enumerates every section kind with stable keys", () => {
    const at = "2026-10-08T16:00:00.000Z";
    const base = { outcome: "available" as const, lastAttemptAt: at, errorCode: null };
    expect(
      quotaWindowsFromSection({
        ...base,
        kind: "codex-limits",
        snapshot: {
          fetchedAt: at,
          data: {
            rateLimits: [
              {
                id: "spark",
                name: null,
                planType: null,
                primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_792_000_000 },
                secondary: {
                  usedPercent: 1,
                  windowDurationMins: null,
                  resetsAt: Number.MAX_SAFE_INTEGER,
                },
                credits: null,
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        windowKey: "spark:primary",
        label: "5-hour limit",
        usedPercent: 5,
        resetsAt: new Date(1_792_000_000_000).toISOString(),
        durationMinutes: 300,
      },
      {
        windowKey: "spark:secondary",
        label: "Secondary limit",
        usedPercent: 1,
        resetsAt: null,
        durationMinutes: null,
      },
    ]);
    const claude = {
      ...base,
      kind: "claude-usage" as const,
      snapshot: {
        fetchedAt: at,
        data: {
          subscriptionLabel: null,
          limitsAvailable: true,
          windows: [{ key: "five_hour", label: "5-hour limit", utilization: null, resetsAt: null }],
          extraUsage: { enabled: true, utilization: 50 },
        },
      },
    };
    expect(quotaWindowsFromSection(claude)).toEqual([
      {
        windowKey: "five_hour",
        label: "5-hour limit",
        usedPercent: null,
        resetsAt: null,
        durationMinutes: 300,
      },
    ]);
    expect(
      quotaWindowsFromSection({
        ...claude,
        snapshot: { ...claude.snapshot, data: { ...claude.snapshot.data, limitsAvailable: false } },
      }),
    ).toEqual([]);
    expect(
      quotaWindowsFromSection({
        ...base,
        kind: "provider-limits",
        snapshot: {
          fetchedAt: at,
          data: { windows: [{ id: "monthly", label: "Monthly", usedPercent: 3, resetsAt: at }] },
        },
      }),
    ).toEqual([
      {
        windowKey: "monthly",
        label: "Monthly",
        usedPercent: 3,
        resetsAt: at,
        durationMinutes: null,
      },
    ]);
    expect(
      quotaWindowsFromSection({
        ...base,
        kind: "codex-tokens",
        snapshot: { fetchedAt: at, data: { tokenSummary: null, dailyUsageBuckets: [] } },
      }),
    ).toEqual([]);
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
