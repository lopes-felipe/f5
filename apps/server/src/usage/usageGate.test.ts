import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderInstanceId, UsageAccount } from "@t3tools/contracts";
import { hasFreshUsageCapacity, scheduledUsageRetryAt } from "./usageGate.ts";

const at = "2026-10-20T12:00:00.000Z";
const now = Date.parse(at);
const section = (kind: string, data: unknown) => ({
  kind,
  outcome: "available",
  snapshot: { fetchedAt: at, data },
  lastAttemptAt: at,
  errorCode: null,
});
const account = (provider: string, sections: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownSync(UsageAccount)({
    key: `${provider}:default`,
    provider,
    providerInstanceId: provider,
    displayName: provider,
    enabled: true,
    refreshState: "idle",
    sections,
  });

describe("usage gate with monthly allowances", () => {
  const codex = (usedPercent: number, resetsAt: number) =>
    account("codex", [
      section("codex-limits", {
        rateLimits: [
          {
            id: "codex",
            name: null,
            planType: "enterprise_cbp_usage_based",
            primary: null,
            secondary: null,
            individual: { usedPercent, windowDurationMins: null, resetsAt },
            credits: null,
          },
        ],
      }),
    ]);
  const selection = { instanceId: ProviderInstanceId.makeUnsafe("codex"), model: "gpt-5" };
  const inTwoDays = Date.parse("2026-10-22T12:00:00.000Z") / 1000;
  const nextMonth = Date.parse("2026-11-01T00:00:00.000Z") / 1000;

  it("treats a Codex monthly credit allowance as capacity evidence", () => {
    expect(hasFreshUsageCapacity([codex(40, nextMonth)], selection, now)).toBe(true);
    expect(hasFreshUsageCapacity([codex(100, nextMonth)], selection, now)).toBe(false);
  });

  it("retries after an exhausted allowance resets, but only within the horizon", () => {
    expect(scheduledUsageRetryAt([codex(100, inTwoDays)], selection, now)).toBe(
      "2026-10-22T12:01:00.000Z",
    );
    expect(scheduledUsageRetryAt([codex(100, nextMonth)], selection, now)).toBeNull();
  });

  it("never gates Claude on the monthly spend meter", () => {
    const claude = account("claudeAgent", [
      section("claude-usage", {
        subscriptionLabel: null,
        limitsAvailable: true,
        windows: [
          { key: "five_hour", label: "5-hour limit", utilization: 20, resetsAt: null },
          { key: "monthly_spend", label: "Monthly spend", utilization: 104, resetsAt: null },
        ],
        extraUsage: { enabled: true, utilization: 104 },
      }),
    ]);
    const claudeSelection = {
      instanceId: ProviderInstanceId.makeUnsafe("claudeAgent"),
      model: "claude-sonnet-4",
    };
    expect(hasFreshUsageCapacity([claude], claudeSelection, now)).toBe(true);
    expect(scheduledUsageRetryAt([claude], claudeSelection, now)).toBeNull();
  });
});
