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
    ]);
    expect(normalized.extraUsage).toEqual({ enabled: true, utilization: 12 });
    expect(
      normalizeClaudeAccountUsage(
        payload({ ...limits, model_scoped: [...limits.model_scoped].reverse() }),
      ),
    ).toEqual(normalized);
  });
});
