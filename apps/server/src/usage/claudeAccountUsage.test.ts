import { describe, expect, it } from "vitest";
import { normalizeClaudeAccountUsage } from "./claudeAccountUsage.ts";

const payload = (rate_limits: unknown) => ({
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits,
});
describe("Claude account normalization", () => {
  it.each([null, 0, 42, 120, -1, Infinity, NaN])(
    "preserves percentage semantics for %s",
    (utilization) => {
      const value = normalizeClaudeAccountUsage(
        payload({ five_hour: { utilization, resets_at: "bad date" } }),
      );
      expect(value.windows[0]?.utilization).toBe(
        typeof utilization === "number" && Number.isFinite(utilization) && utilization >= 0
          ? utilization
          : null,
      );
      expect(value.windows[0]?.resetsAt).toBeNull();
      expect(value.subscriptionLabel).toBe("Max");
    },
  );
  it("treats unavailable limits as a successful neutral snapshot", () => {
    expect(
      normalizeClaudeAccountUsage({ subscription_type: null, rate_limits_available: false }),
    ).toEqual({ subscriptionLabel: null, limitsAvailable: false, windows: [], extraUsage: null });
  });
  it.each([null, {}, { rate_limits_available: true }, payload([])])(
    "rejects malformed responses",
    (value) => {
      expect(() => normalizeClaudeAccountUsage(value)).toThrow("invalid-response");
    },
  );
  it("keeps stable model keys, prefers named model windows, and excludes monetary and session data", () => {
    const limits = {
      seven_day_opus: { utilization: 10 },
      seven_day_sonnet: { utilization: 11 },
      model_scoped: [
        { display_name: " Opus ", utilization: 42, resets_at: "2026-09-05T12:00:00Z" },
        { display_name: "opus", utilization: 42, resets_at: "2026-09-05T12:00:00Z" },
        { display_name: "Fable", utilization: 42, resets_at: "2026-09-05T12:00:00Z" },
      ],
      extra_usage: {
        is_enabled: true,
        utilization: 12,
        monthly_limit: 10000,
        used_credits: 1000,
        currency: "USD",
      },
    };
    const normalized = normalizeClaudeAccountUsage(payload(limits));
    expect(normalized.windows.map((w) => w.key)).toEqual([
      "seven_day_sonnet",
      "model:fable",
      "model:opus",
      "monthly_spend",
    ]);
    expect(normalized.windows.at(-1)?.utilization).toBe(10);
    expect(normalized.extraUsage).toEqual({ enabled: true, utilization: 12 });
    expect(
      normalizeClaudeAccountUsage(
        payload({ ...limits, model_scoped: [...limits.model_scoped].reverse() }),
      ),
    ).toEqual(normalized);
  });
});

describe("Claude monthly spend budget", () => {
  const enterprise = {
    five_hour: null,
    seven_day: null,
    spend: {
      enabled: true,
      used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
      limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
      percent: 9,
    },
    extra_usage: {
      is_enabled: true,
      used_credits: 4_631,
      monthly_limit: 50_000,
      utilization: 9.261999999999999,
      currency: "USD",
      decimal_places: 2,
    },
  };
  const monthly = {
    key: "monthly_spend",
    label: "Monthly spend",
    utilization: expect.closeTo(9.262, 10),
    resetsAt: null,
  };

  it("maps an Enterprise budget precisely, preferring spend beside rolling windows", () => {
    expect(normalizeClaudeAccountUsage(payload(enterprise)).windows).toEqual([monthly]);
    expect(
      normalizeClaudeAccountUsage(
        payload({
          ...enterprise,
          five_hour: { utilization: 12, resets_at: null },
          extra_usage: { ...enterprise.extra_usage, used_credits: 30_000, utilization: 60 },
        }),
      ).windows,
    ).toEqual([
      { key: "five_hour", label: "5-hour limit", utilization: 12, resetsAt: null },
      monthly,
    ]);
  });

  it("falls back to enabled extra usage amounts or utilization when spend is unusable", () => {
    const disabledSpend = {
      ...enterprise,
      spend: {
        ...enterprise.spend,
        enabled: false,
        used: { amount_minor: 30_000, currency: "USD", exponent: 2 },
      },
      extra_usage: { ...enterprise.extra_usage, utilization: 9 },
    };
    expect(normalizeClaudeAccountUsage(payload(disabledSpend)).windows).toEqual([monthly]);
    expect(
      normalizeClaudeAccountUsage(
        payload({
          ...disabledSpend,
          spend: { enabled: true, used: null, limit: null, percent: 9 },
          extra_usage: { ...enterprise.extra_usage, used_credits: null, monthly_limit: null },
        }),
      ).windows,
    ).toEqual([monthly]);
  });

  it("omits disabled budgets and refuses mismatched or zero limits without a fallback", () => {
    const extra_usage = { ...enterprise.extra_usage, is_enabled: false };
    for (const spend of [
      { ...enterprise.spend, enabled: false },
      { ...enterprise.spend, limit: { ...enterprise.spend.limit, currency: "EUR" } },
      { ...enterprise.spend, limit: { ...enterprise.spend.limit, exponent: 0 } },
      { ...enterprise.spend, limit: { ...enterprise.spend.limit, amount_minor: 0 } },
    ])
      expect(
        normalizeClaudeAccountUsage(payload({ ...enterprise, spend, extra_usage })).windows,
      ).toEqual([]);
  });

  it("caps an overspent budget at the full window", () => {
    expect(
      normalizeClaudeAccountUsage(
        payload({
          ...enterprise,
          spend: {
            ...enterprise.spend,
            used: { ...enterprise.spend.used, amount_minor: 60_000 },
          },
        }),
      ).windows,
    ).toEqual([{ ...monthly, utilization: 100 }]);
  });
});

it.each(["Claude Opus 4.5", "Opus 4.1", "claude-opus-4-5"])(
  "prefers versioned %s over the legacy Opus window",
  (display_name) => {
    const result = normalizeClaudeAccountUsage(
      payload({
        seven_day_opus: { utilization: 10 },
        seven_day_sonnet: { utilization: 10 },
        model_scoped: [
          { display_name, utilization: 10 },
          { display_name: "Fable", utilization: 10 },
        ],
      }),
    );
    expect(result.windows.map((window) => window.key)).not.toContain("seven_day_opus");
    expect(result.windows.map((window) => window.key)).toContain("seven_day_sonnet");
    expect(result.windows).toHaveLength(3);
  },
);
it("recognizes versioned Sonnet but does not invent equivalence for unknown aliases", () => {
  const result = normalizeClaudeAccountUsage(
    payload({
      seven_day_opus: { utilization: 10 },
      seven_day_sonnet: { utilization: 10 },
      model_scoped: [
        { display_name: "Claude Sonnet 4.5", utilization: 10 },
        { display_name: "My Opus alias", utilization: 10 },
      ],
    }),
  );
  expect(result.windows.map((window) => window.key)).toContain("seven_day_opus");
  expect(result.windows.map((window) => window.key)).not.toContain("seven_day_sonnet");
});
