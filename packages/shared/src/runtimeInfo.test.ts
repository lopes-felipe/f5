import { describe, expect, it } from "vitest";
import { normalizeProviderRuntimeInfo } from "./runtimeInfo";
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
          fast_mode_state: "enabled",
        },
      ),
    ).toEqual({
      requested: { model: "requested", effort: "high", thinking: "adaptive", fastMode: "enabled" },
      effective: { model: "fallback", effort: "medium", thinking: "disabled", fastMode: "enabled" },
      fallback: "model: requested → fallback; effort: high → medium; thinking: adaptive → disabled",
    });
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
