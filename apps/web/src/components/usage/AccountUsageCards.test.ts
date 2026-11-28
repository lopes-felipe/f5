import { describe, expect, it } from "vitest";
import {
  ProviderInstanceId,
  type AccountUsageSection,
  type UsageAccount,
} from "@t3tools/contracts";

import {
  accountStatusText,
  antigravityLimitsNotice,
  quotaExhaustedText,
} from "./AccountUsageCards";

type LimitsSection = Extract<AccountUsageSection, { kind: "provider-limits" }>;

const limits = (fields: Partial<LimitsSection> = {}): LimitsSection => ({
  kind: "provider-limits",
  outcome: "unsupported",
  lastAttemptAt: null,
  snapshot: null,
  errorCode: "unsupported",
  ...fields,
});

const account = (
  section: AccountUsageSection,
  provider: UsageAccount["provider"] = "antigravity",
): UsageAccount => ({
  key: `${provider}:test`,
  provider,
  providerInstanceId: ProviderInstanceId.make("test"),
  displayName: "Test",
  enabled: true,
  refreshState: "idle",
  sections: [section],
});

describe("Antigravity limits text", () => {
  it("names the real reason instead of an unsupported CLI version", () => {
    expect(accountStatusText(account(limits({ readsDisabled: true })))).toBe(
      'Limits are off. Turn on "Read limits with the Antigravity CLI" in Settings → Providers.',
    );
    expect(accountStatusText(account(limits({ unsupportedReason: "cli-too-old" })))).toBe(
      "Update Antigravity in Settings to read limits.",
    );
    expect(accountStatusText(account(limits({ unsupportedReason: "cli-spends-turn" })))).toBe(
      "This Antigravity version can't report limits without using a turn, so F5 stopped asking.",
    );
    for (const section of [limits({ readsDisabled: true }), limits()])
      expect(accountStatusText(account(section))).not.toMatch(/does not expose/);
  });

  it("leaves other providers' unsupported text unchanged", () => {
    const section = limits({ readsDisabled: true });
    expect(antigravityLimitsNotice(account(section, "cursor"), section)).toBeNull();
    expect(accountStatusText(account(section, "cursor"))).toBe(
      "This installed Cursor version does not expose account usage and rate limits.",
    );
  });

  it("leads with a quota stop a turn reported", () => {
    const section = limits({
      readsDisabled: true,
      quotaExhausted: { observedAt: "2026-11-28T12:00:00.000Z", resetsAt: null },
    });
    expect(quotaExhaustedText(section)).toBe("Quota reached during a turn.");
    expect(accountStatusText(account(section))).toBe("Quota reached during a turn.");
    expect(
      quotaExhaustedText(
        limits({
          quotaExhausted: {
            observedAt: "2026-11-28T12:00:00.000Z",
            resetsAt: "2026-11-28T13:00:00.000Z",
          },
        }),
      ),
    ).toMatch(/^Quota reached during a turn · resets .+\.$/);
    expect(quotaExhaustedText(limits())).toBeNull();
  });
});
