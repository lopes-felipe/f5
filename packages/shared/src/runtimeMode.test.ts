import { describe, expect, it } from "vitest";

import { runtimeModeCapabilities, effectiveRuntimeMode } from "./runtimeMode";

describe("runtimeModeCapabilities", () => {
  it("uses supervised mode for stored Antigravity Auto threads", () => {
    expect(runtimeModeCapabilities("antigravity").has("auto")).toBe(false);
    expect(effectiveRuntimeMode("antigravity", "auto")).toBe("approval-required");
    expect(effectiveRuntimeMode("antigravity", "full-access")).toBe("full-access");
    expect(effectiveRuntimeMode("codex", "auto")).toBe("auto");
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
