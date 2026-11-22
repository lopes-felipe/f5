import { describe, expect, it } from "vitest";

import { runtimeModeCapabilities, runtimeModeUnsupportedReason } from "./runtimeMode";

describe("runtimeModeCapabilities", () => {
  it("rejects unsupported Antigravity Auto consistently with scheduled tasks", () => {
    expect(runtimeModeCapabilities("antigravity").has("auto")).toBe(false);
    expect(runtimeModeUnsupportedReason("antigravity", "auto")).toBeDefined();
  });
  it("offers Antigravity Auto-accept edits and follows the instance's advertised modes", () => {
    expect([...runtimeModeCapabilities("antigravity")]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    const advertised = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
    expect(runtimeModeCapabilities("antigravity", advertised).has("auto")).toBe(true);
    expect(runtimeModeUnsupportedReason("antigravity", "auto", advertised)).toBeUndefined();
    // An empty list (an older server snapshot) falls back to the static matrix.
    expect(runtimeModeCapabilities("antigravity", []).has("auto")).toBe(false);
  });
  it("exposes the fail-closed provider capability matrix", () => {
    expect([...runtimeModeCapabilities("codex")]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    // Claude `auto` is offered but falls back to asking when unsupported.
    expect([...runtimeModeCapabilities("claudeAgent")]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect([...runtimeModeCapabilities("opencode")]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    expect([...runtimeModeCapabilities("cursor")]).toEqual(["approval-required", "full-access"]);
    expect([...runtimeModeCapabilities("grok")]).toEqual(["approval-required", "full-access"]);
  });
});
