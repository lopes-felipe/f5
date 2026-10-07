import { ProviderInstanceId, type RuntimeUsageLimit, type UsageAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { usageResumeTargetAfterCredit } from "./usageResumeAfterCredit.ts";
const after = "2026-10-07T12:00:00.000Z";
const now = Date.parse(after) + 1000;
const limit: RuntimeUsageLimit = {
  windows: [
    { id: "five_hour", label: "5-hour", resetsAt: null },
    { id: "seven_day", label: "Weekly", resetsAt: null },
  ],
  resetsAt: null,
  resetSource: "provider",
  evidence: "typed",
};
function account(used: number, outcome: "available" | "unavailable" = "available"): UsageAccount {
  return {
    key: "claude",
    provider: "claudeAgent",
    providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
    displayName: "Claude",
    enabled: true,
    refreshState: "idle",
    sections: [
      {
        kind: "claude-usage",
        outcome,
        lastAttemptAt: new Date(now).toISOString(),
        errorCode: null,
        snapshot: {
          fetchedAt: new Date(now).toISOString(),
          data: {
            limitsAvailable: true,
            subscriptionLabel: null,
            extraUsage: null,
            windows: limit.windows.map((w) => ({
              key: w.id,
              label: w.label!,
              utilization: used,
              resetsAt: "2026-10-08T12:00:00.000Z",
            })),
          },
        },
      },
    ],
  };
}
describe("explicit reset credit recovery", () => {
  it("continues early only when every tracked bucket is freshly available", () => {
    expect(usageResumeTargetAfterCredit(limit, account(0), after, now)).toBe(
      new Date(now).toISOString(),
    );
    expect(usageResumeTargetAfterCredit(limit, account(0, "unavailable"), after, now)).toBeNull();
    expect(
      usageResumeTargetAfterCredit(limit, account(0), new Date(now).toISOString(), now),
    ).toBeNull();
    expect(
      usageResumeTargetAfterCredit(
        { ...limit, windows: [...limit.windows, { id: "unknown", label: null, resetsAt: null }] },
        account(0),
        after,
        now,
      ),
    ).toBeNull();
  });
  it("postpones an exhausted bucket to its fresh reset plus buffer", () => {
    expect(usageResumeTargetAfterCredit(limit, account(100), after, now)).toBe(
      "2026-10-08T12:01:00.000Z",
    );
  });
});
