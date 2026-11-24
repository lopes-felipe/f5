import type { UsageAccount, AccountUsageSection } from "@t3tools/contracts";
import { expect, it } from "vitest";
import type { QuotaWindow } from "@t3tools/shared/usageLimit";
import { sidebarUsageWindows, sidebarWeeklyUsageWindow } from "./sidebarUsageWindows";

const window = (
  windowKey: string,
  usedPercent: number | null,
  durationMinutes = 10_080,
): QuotaWindow => ({
  windowKey,
  label: windowKey,
  usedPercent,
  durationMinutes,
  resetsAt: null,
});

it("uses Claude's all-model weekly consumption instead of the session or model quota", () => {
  const weekly = window("seven_day", 25);
  expect(
    sidebarWeeklyUsageWindow([window("five_hour", 99, 300), window("seven_day_fable", 80), weekly]),
  ).toBe(weekly);
});

it("uses Codex's main weekly quota ahead of model-specific weekly limits", () => {
  const weekly = window("codex:secondary", 40);
  expect(
    sidebarWeeklyUsageWindow([
      window("codex:primary", 95, 300),
      window("codex_spark:secondary", 90),
      weekly,
    ]),
  ).toBe(weekly);
});

it("shows the tightest weekly pool when no account-wide weekly quota exists", () => {
  const shared = window("3p-weekly", 60);
  expect(
    sidebarWeeklyUsageWindow([
      window("gemini-weekly", 10),
      window("gemini-5h", 95, 300),
      shared,
      window("unknown-weekly", null),
    ]),
  ).toBe(shared);
});

it("retains unknown weekly consumption and does not substitute a short-term quota", () => {
  expect(sidebarWeeklyUsageWindow([window("seven_day", null)])?.usedPercent).toBeNull();
  expect(sidebarWeeklyUsageWindow([window("five_hour", 80, 300)])).toBeUndefined();
  expect(sidebarWeeklyUsageWindow([])).toBeUndefined();
});

it("uses a reported weekly quota when the provider has no account-wide window", () => {
  const weekly = window("seven_day_fable", 60);
  expect(sidebarWeeklyUsageWindow([weekly])).toBe(weekly);
});

const section = (percent: number, fetchedAt: string): AccountUsageSection => ({
  kind: "provider-limits",
  outcome: "available",
  lastAttemptAt: fetchedAt,
  errorCode: null,
  snapshot: {
    fetchedAt,
    data: { windows: [{ id: "seven_day", label: "Weekly", usedPercent: percent, resetsAt: null }] },
  },
});

it("shows each reported window once and retains the newest snapshot regardless of section order", () => {
  const older = section(10, "2026-11-14T10:00:00Z");
  const newer = section(20, "2026-11-14T11:00:00Z");
  const account: UsageAccount = {
    key: "test",
    provider: "opencode",
    providerInstanceId: null,
    displayName: "Test",
    enabled: true,
    refreshState: "idle",
    sections: [],
  };
  for (const sections of [
    [older, newer],
    [newer, older],
  ]) {
    expect(sidebarUsageWindows({ ...account, sections })).toMatchObject([
      { windowKey: "seven_day", usedPercent: 20 },
    ]);
    expect(sidebarUsageWindows({ ...account, sections })).toHaveLength(1);
  }
});

it("retains Codex short-term limits only in the persistent display", () => {
  const account: UsageAccount = {
    key: "codex",
    provider: "codex",
    providerInstanceId: null,
    displayName: "Codex",
    enabled: true,
    refreshState: "idle",
    sections: [
      {
        ...section(20, "2026-11-14T11:00:00Z"),
        kind: "codex-limits",
        snapshot: {
          fetchedAt: "2026-11-14T11:00:00Z",
          data: {
            rateLimits: [
              {
                id: "codex",
                name: null,
                planType: null,
                credits: null,
                primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
                secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
              },
            ],
          },
        },
      },
    ],
  };
  expect(sidebarUsageWindows(account)).toHaveLength(1);
  expect(sidebarUsageWindows(account, true)).toHaveLength(2);
});
