import { describe, expect, it } from "vitest";

import {
  ClaudeThinkingConfigError,
  claudeThinkingCliArgs,
  claudeThinkingConfig,
} from "./claudeProviderOptions.ts";

describe("claudeThinkingConfig", () => {
  it("maps the deprecated maxThinkingTokens", () => {
    expect(claudeThinkingConfig({ legacyMaxThinkingTokens: 0, supportsAdaptive: true })).toEqual({
      thinking: { type: "disabled" },
      source: "legacy",
    });
    expect(
      claudeThinkingConfig({ legacyMaxThinkingTokens: 2048, supportsAdaptive: true }),
    ).toMatchObject({ thinking: { type: "adaptive" }, source: "legacy" });
    expect(
      claudeThinkingConfig({ legacyMaxThinkingTokens: 2048, supportsAdaptive: false }),
    ).toEqual({ thinking: { type: "enabled", budgetTokens: 2048 }, source: "legacy" });
    expect(
      claudeThinkingConfig({ legacyMaxThinkingTokens: 2048, supportsAdaptive: undefined }),
    ).toEqual({ thinking: { type: "enabled", budgetTokens: 2048 }, source: "legacy" });
  });

  it("omits thinking with no input and disables it when the toggle is off", () => {
    expect(claudeThinkingConfig({})).toEqual({ source: "default" });
    expect(claudeThinkingConfig({ toggle: false })).toEqual({
      thinking: { type: "disabled" },
      alwaysThinkingEnabled: false,
      source: "toggle",
    });
    expect(claudeThinkingConfig({ toggle: true })).toEqual({
      alwaysThinkingEnabled: true,
      source: "toggle",
    });
  });

  it("applies precedence toggle > typed > legacy > default", () => {
    // Toggle off beats every lower layer.
    expect(
      claudeThinkingConfig({
        toggle: false,
        typed: { type: "enabled", budgetTokens: 1000 },
        legacyMaxThinkingTokens: 500,
      }).thinking,
    ).toEqual({ type: "disabled" });
    // Toggle on keeps the refined shape of a lower layer.
    expect(
      claudeThinkingConfig({ toggle: true, typed: { type: "enabled", budgetTokens: 1000 } }),
    ).toEqual({
      thinking: { type: "enabled", budgetTokens: 1000 },
      alwaysThinkingEnabled: true,
      source: "typed",
    });
    // Toggle on never sends a contradictory disabled config.
    expect(claudeThinkingConfig({ toggle: true, legacyMaxThinkingTokens: 0 })).toEqual({
      alwaysThinkingEnabled: true,
      source: "toggle",
    });
    expect(
      claudeThinkingConfig({
        typed: { type: "disabled" },
        legacyMaxThinkingTokens: 4000,
        supportsAdaptive: true,
      }),
    ).toEqual({ thinking: { type: "disabled" }, source: "typed" });
  });

  it("rejects explicit adaptive thinking on known non-adaptive models only", () => {
    expect(() =>
      claudeThinkingConfig({
        typed: { type: "adaptive" },
        supportsAdaptive: false,
        model: "claude-haiku-4-5",
      }),
    ).toThrow(ClaudeThinkingConfigError);
    expect(
      claudeThinkingConfig({ typed: { type: "adaptive" }, supportsAdaptive: undefined }).thinking,
    ).toEqual({ type: "adaptive" });
  });

  it("mirrors the SDK's CLI translation", () => {
    expect(claudeThinkingCliArgs(undefined)).toEqual([]);
    expect(claudeThinkingCliArgs({ type: "disabled" })).toEqual(["--thinking", "disabled"]);
    expect(claudeThinkingCliArgs({ type: "adaptive", display: "summarized" })).toEqual([
      "--thinking",
      "adaptive",
      "--thinking-display",
      "summarized",
    ]);
    expect(claudeThinkingCliArgs({ type: "enabled", budgetTokens: 900 })).toEqual([
      "--max-thinking-tokens",
      "900",
    ]);
    expect(claudeThinkingCliArgs({ type: "enabled" })).toEqual(["--thinking", "adaptive"]);
  });
});
