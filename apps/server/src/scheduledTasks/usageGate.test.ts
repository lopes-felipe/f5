import { Schema } from "effect";
import { expect, it } from "vitest";
import { UsageAccount, ProviderInstanceId } from "@t3tools/contracts";
import { scheduledUsageRetryAt } from "./usageGate";
const at = "2026-10-20T12:00:00.000Z",
  reset = "2026-10-20T13:00:00.000Z",
  selection = { instanceId: ProviderInstanceId.makeUnsafe("claude"), model: "claude-sonnet-4" };
const account = (key: string, resetsAt: string | null = reset, fetchedAt = at) =>
  Schema.decodeUnknownSync(UsageAccount)({
    key: "claude:default",
    provider: "claudeAgent",
    providerInstanceId: "claude",
    displayName: "Claude",
    enabled: true,
    refreshState: "idle",
    sections: [
      {
        kind: "claude-usage",
        outcome: "available",
        snapshot: {
          fetchedAt,
          data: {
            subscriptionLabel: null,
            limitsAvailable: true,
            windows: [{ key, label: key, utilization: 100, resetsAt }],
            extraUsage: null,
          },
        },
        lastAttemptAt: at,
        nextRefreshAt: null,
        errorCode: null,
        errorMessage: null,
      },
    ],
  });
it("defers only applicable quotas with the existing reset buffer", () => {
  expect(scheduledUsageRetryAt([account("seven_day_opus")], selection, Date.parse(at))).toBeNull();
  expect(
    scheduledUsageRetryAt(
      [account("seven_day_opus")],
      { ...selection, model: "claude-opus-4" },
      Date.parse(at),
    ),
  ).toBe("2026-10-20T13:01:00.000Z");
  expect(scheduledUsageRetryAt([account("seven_day")], selection, Date.parse(at))).toBe(
    "2026-10-20T13:01:00.000Z",
  );
});
it("does not preflight-block from stale, unknown-reset, unrelated-instance or unknown model evidence", () => {
  expect(
    scheduledUsageRetryAt(
      [account("seven_day", reset, "2026-10-20T11:00:00Z")],
      selection,
      Date.parse(at),
    ),
  ).toBeNull();
  expect(scheduledUsageRetryAt([account("seven_day", null)], selection, Date.parse(at))).toBeNull();
  expect(
    scheduledUsageRetryAt(
      [account("seven_day")],
      { ...selection, instanceId: ProviderInstanceId.makeUnsafe("other") },
      Date.parse(at),
    ),
  ).toBeNull();
  expect(
    scheduledUsageRetryAt([account("seven_day_unknown_model")], selection, Date.parse(at)),
  ).toBeNull();
});
