import type { UsageAccount, AccountUsageSection } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { sidebarUsageWindows } from "./sidebarUsageWindows";

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
