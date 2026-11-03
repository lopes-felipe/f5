import { describe, expect, it } from "vitest";

import {
  createReportedClaudeModelCapabilities,
  createReportedCodexModelCapabilities,
  normalizeCodexModelOptions,
  normalizeClaudeModelOptions,
  resolveClaudeModelEffort,
  resolveCodexDispatchModelOptions,
  resolveCodexEffectiveReasoningEffort,
  resolveModelCapabilities,
  resolveSupportedEffort,
} from "./model";

describe("resolveModelCapabilities", () => {
  it("preserves only explicit SDK effort for uncatalogued Claude models", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(resolveClaudeModelEffort("custom-model", ` ${effort} `)).toBe(effort);
      expect(normalizeClaudeModelOptions("custom-model", { effort })).toEqual({ effort });
    }
    for (const effort of [undefined, null, "", "HIGH", "extreme", "ultrathink"]) {
      expect(resolveClaudeModelEffort("custom-model", effort)).toBeNull();
    }
    expect(normalizeClaudeModelOptions("custom-model", {})).toBeUndefined();
    const unsupported = createReportedClaudeModelCapabilities({
      value: "custom-model",
      supportsEffort: false,
    });
    expect(resolveClaudeModelEffort("custom-model", "max", unsupported)).toBeNull();
    expect(resolveClaudeModelEffort("claude-haiku-4-5", "max")).toBeNull();
  });

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

describe("reported facts are tri-state", () => {
  it("sends no Claude effort when the SDK reports effort as unsupported", () => {
    const reported = createReportedClaudeModelCapabilities({
      value: "claude-opus-5-5",
      supportsEffort: false,
    });
    const resolved = resolveModelCapabilities("claudeAgent", "claude-opus-5-5", reported);
    expect(resolved.effortOptions).toEqual([]);
    expect(resolved.defaultEffort).toBeUndefined();
  });

  it("keeps F5's Claude efforts and fast mode when the SDK does not report them", () => {
    const reported = createReportedClaudeModelCapabilities({ value: "claude-opus-5-5" });
    const resolved = resolveModelCapabilities("claudeAgent", "claude-opus-5-5", reported);
    const builtIn = resolveModelCapabilities("claudeAgent", "claude-opus-5-5");
    expect(resolved.effortOptions).toEqual(builtIn.effortOptions);
    expect(resolved.supportsFastMode).toBe(true);
    expect(reported.optionDescriptors?.some((entry) => entry.id === "fastMode")).toBe(true);
  });

  it("drops Claude fast mode only on an explicit negative report", () => {
    const reported = createReportedClaudeModelCapabilities({
      value: "claude-opus-5-5",
      supportsFastMode: false,
    });
    expect(
      resolveModelCapabilities("claudeAgent", "claude-opus-5-5", reported).supportsFastMode,
    ).toBe(false);
  });

  it("treats an empty Codex effort list as none and absent tiers as unreported", () => {
    const noEfforts = createReportedCodexModelCapabilities({
      model: "gpt-cli-only",
      supportedReasoningEfforts: [],
    });
    const resolved = resolveModelCapabilities("codex", "gpt-cli-only", noEfforts);
    expect(resolved.effortOptions).toEqual([]);
    expect(resolved.defaultEffort).toBeUndefined();
    expect(resolved.supportsFastMode).toBe(true);
    const noTiers = createReportedCodexModelCapabilities({
      model: "gpt-cli-only",
      serviceTiers: [],
    });
    expect(resolveModelCapabilities("codex", "gpt-cli-only", noTiers).supportsFastMode).toBe(false);
  });
});

describe("normalizeCodexModelOptions with reported capabilities", () => {
  const reported = createReportedCodexModelCapabilities({
    model: "gpt-6.1-sol",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "low",
    serviceTiers: [],
  });

  it("keeps a reported effort that equals the built-in default", () => {
    // The built-in default for this slug is "high"; the reported default is "low".
    expect(normalizeCodexModelOptions("gpt-6.1-sol", { reasoningEffort: "high" })).toBeUndefined();
    expect(
      normalizeCodexModelOptions("gpt-6.1-sol", { reasoningEffort: "high" }, reported),
    ).toEqual({ reasoningEffort: "high" });
    expect(
      normalizeCodexModelOptions("gpt-6.1-sol", { reasoningEffort: "low" }, reported),
    ).toBeUndefined();
  });

  it("walks an unsupported effort down instead of dropping it", () => {
    // [low, high] reported: Max is unsupported, and turn/start would run High.
    expect(normalizeCodexModelOptions("gpt-6.1-sol", { reasoningEffort: "max" }, reported)).toEqual(
      { reasoningEffort: "high" },
    );
  });

  it("drops fast mode the model does not offer", () => {
    expect(normalizeCodexModelOptions("gpt-6.1-sol", { fastMode: true }, reported)).toBeUndefined();
  });
});

describe("Codex effective and dispatched effort", () => {
  const reported = createReportedCodexModelCapabilities({
    model: "gpt-6.1-sol",
    supportedReasoningEfforts: [
      { reasoningEffort: "max" },
      { reasoningEffort: "high" },
      { reasoningEffort: "low" },
    ],
    defaultReasoningEffort: "low",
    serviceTiers: [],
  });

  it("resolves an absent effort to the reported default, not the built-in one", () => {
    expect(resolveCodexEffectiveReasoningEffort("gpt-6.1-sol", undefined, reported)).toBe("low");
    expect(resolveCodexEffectiveReasoningEffort("gpt-6.1-sol", undefined)).toBe("high");
  });

  it("walks an unsupported effort down to a reported one, as turn/start does", () => {
    expect(resolveCodexEffectiveReasoningEffort("gpt-6.1-sol", "ultra", reported)).toBe("max");
    expect(resolveCodexEffectiveReasoningEffort("gpt-6.1-sol", "xhigh", reported)).toBe("high");
    expect(resolveCodexEffectiveReasoningEffort("gpt-6.1-sol", "bogus", reported)).toBe("low");
  });

  it("is undefined for a reported model that takes no effort", () => {
    const noEfforts = createReportedCodexModelCapabilities({
      model: "gpt-no-effort",
      supportedReasoningEfforts: [],
    });
    expect(resolveCodexEffectiveReasoningEffort("gpt-no-effort", "high", noEfforts)).toBe(
      undefined,
    );
    expect(resolveCodexDispatchModelOptions("gpt-no-effort", undefined, noEfforts)).toBe(undefined);
  });

  it("dispatches the default effort explicitly", () => {
    // Built-in only: "high" is the built-in default, still sent.
    expect(resolveCodexDispatchModelOptions("gpt-6.1-sol", { reasoningEffort: "high" })).toEqual({
      reasoningEffort: "high",
    });
    expect(resolveCodexDispatchModelOptions("gpt-6.1-sol", undefined, reported)).toEqual({
      reasoningEffort: "low",
    });
    expect(
      resolveCodexDispatchModelOptions("gpt-6.1-sol", { reasoningEffort: "ultra" }, reported),
    ).toEqual({ reasoningEffort: "max" });
  });
});
