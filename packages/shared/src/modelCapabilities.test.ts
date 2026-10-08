import { describe, expect, it } from "vitest";

import {
  createReportedClaudeModelCapabilities,
  createReportedCodexModelCapabilities,
  resolveModelCapabilities,
  resolveSupportedEffort,
} from "./model";

describe("resolveModelCapabilities", () => {
  it("falls back to built-ins without reported capabilities", () => {
    const resolved = resolveModelCapabilities("codex", "gpt-5.4");
    expect(resolved.source).toBe("built-in");
    expect(resolved.effortOptions.length).toBeGreaterThan(0);
  });

  it("uses reported Claude efforts and fast mode for a CLI-only model", () => {
    const reported = createReportedClaudeModelCapabilities({
      value: "claude-cli-only-9",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "max", "bogus"],
      supportsFastMode: true,
    });
    const resolved = resolveModelCapabilities("claudeAgent", "claude-cli-only-9", reported);
    expect(resolved.source).toBe("reported");
    expect(resolved.effortOptions).toEqual(["low", "medium", "max"]);
    expect(resolved.supportsFastMode).toBe(true);
    expect(resolveSupportedEffort(resolved, "max")).toBe("max");
    expect(resolveSupportedEffort(resolved, "xhigh")).toBeNull();
  });

  it("reads Codex service tiers, never additionalSpeedTiers, and carries the upgrade advisory", () => {
    const reported = createReportedCodexModelCapabilities({
      model: "gpt-cli-only",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "xhigh" }],
      defaultReasoningEffort: "xhigh",
      serviceTiers: [{ id: "flex", name: "Flex" }],
      upgrade: "gpt-cli-next",
      ...({ additionalSpeedTiers: ["fast"] } as object),
    });
    const resolved = resolveModelCapabilities("codex", "gpt-cli-only", reported);
    expect(resolved.effortOptions).toEqual(["xhigh", "low"]);
    expect(resolved.defaultEffort).toBe("xhigh");
    expect(resolved.serviceTiers.map((tier) => tier.id)).toEqual(["flex"]);
    expect(resolved.supportsFastMode).toBe(false);
    expect(resolved.upgradeTo).toBe("gpt-cli-next");
  });
});
