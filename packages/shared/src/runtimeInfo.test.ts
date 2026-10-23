import { describe, expect, it } from "vitest";
import {
  fastModeDisabledReasonHelp,
  normalizeProviderRuntimeInfo,
  refusedFastModeReason,
} from "./runtimeInfo";
import { readRuntimeConfiguredPayload } from "./orchestrationActivityPayload";
describe("normalized runtime information", () => {
  it("keeps requested and effective values distinct, including disabled toggles", () => {
    expect(
      normalizeProviderRuntimeInfo(
        { model: "requested", effort: "high", thinking: { type: "adaptive" }, fastMode: true },
        {
          model: "fallback",
          effort: "medium",
          alwaysThinkingEnabled: false,
          fast_mode_state: "on",
        },
      ),
    ).toEqual({
      requested: { model: "requested", effort: "high", thinking: "adaptive", fastMode: "on" },
      effective: { model: "fallback", effort: "medium", thinking: "disabled", fastMode: "on" },
      fallback: "model: requested → fallback; effort: high → medium; thinking: adaptive → disabled",
    });
  });
  it("compares fast mode in the provider's on/off vocabulary", () => {
    expect(normalizeProviderRuntimeInfo({ fastMode: false }, { fastMode: "disabled" })).toEqual({
      requested: { fastMode: "off" },
      effective: { fastMode: "off" },
    });
    expect(
      normalizeProviderRuntimeInfo({ fastMode: true }, { fast_mode_state: "cooldown" }).fallback,
    ).toBe("fastMode: on → cooldown");
  });
  it("explains why the provider refused fast mode", () => {
    expect(
      normalizeProviderRuntimeInfo(
        { fastMode: true },
        { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
      ).fallback,
    ).toBe("fastMode: on → off (usage credits not enabled)");
    expect(
      normalizeProviderRuntimeInfo(
        { fastMode: true },
        { fast_mode_state: "off", fast_mode_disabled_reason: "brand_new_reason" },
      ).fallback,
    ).toBe("fastMode: on → off (brand_new_reason)");
  });
  it("points refused fast mode at where the user can fix it", () => {
    expect(
      fastModeDisabledReasonHelp("extra_usage_disabled").links.map((link) => link.url),
    ).toEqual([
      "https://claude.ai/settings/usage",
      "https://code.claude.com/docs/en/fast-mode#requirements",
    ]);
    expect(fastModeDisabledReasonHelp("model_not_allowed").links.map((link) => link.url)).toEqual([
      "https://code.claude.com/docs/en/fast-mode#requirements",
    ]);
  });
  it("gives transient and environment reasons their own help", () => {
    expect(fastModeDisabledReasonHelp("pending")).toEqual({
      text: expect.stringContaining("still checking"),
      links: [],
    });
    expect(fastModeDisabledReasonHelp("network_error").links[0]?.url).toBe(
      "https://code.claude.com/docs/en/fast-mode#use-fast-mode-behind-proxies-and-llm-gateways",
    );
    expect(fastModeDisabledReasonHelp("disabled_by_env").text).toContain(
      "CLAUDE_CODE_DISABLE_FAST_MODE",
    );
  });
  it("reports a refusal only for fast mode the user requested", () => {
    const refused = {
      fastModeState: "off",
      fastModeDisabledReason: "extra_usage_disabled",
      runtimeInfo: normalizeProviderRuntimeInfo(
        { fastMode: true },
        { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
      ),
    };
    expect(refusedFastModeReason(refused)).toBe("extra_usage_disabled");
    expect(
      refusedFastModeReason({
        ...refused,
        runtimeInfo: normalizeProviderRuntimeInfo({ fastMode: false }, { fast_mode_state: "off" }),
      }),
    ).toBeUndefined();
    expect(refusedFastModeReason({ ...refused, runtimeInfo: undefined })).toBeUndefined();
    // Activities stored before requests were normalized say "enabled".
    expect(
      refusedFastModeReason({
        ...refused,
        runtimeInfo: { requested: { fastMode: "enabled" }, effective: { fastMode: "off" } },
      }),
    ).toBe("extra_usage_disabled");
  });
  it("ignores a disabled reason when fast mode matches the request", () => {
    expect(
      normalizeProviderRuntimeInfo(
        { fastMode: false },
        { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
      ),
    ).toEqual({ requested: { fastMode: "off" }, effective: { fastMode: "off" } });
  });
  it("does not infer missing native reports or reinterpret usage and cost", () => {
    expect(
      normalizeProviderRuntimeInfo({ model: "requested" }, { total_cost_usd: 15, tokensUsed: 100 }),
    ).toEqual({ requested: { model: "requested" }, effective: {} });
  });
  it("preserves the normalized report through activity persistence", () => {
    const runtimeInfo = normalizeProviderRuntimeInfo(
      { model: "requested" },
      { model: "effective" },
    );
    const payload = readRuntimeConfiguredPayload({ config: { model: "effective", runtimeInfo } });
    expect(payload?.runtimeInfo).toEqual(runtimeInfo);
  });
});
