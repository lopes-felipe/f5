import { describe, expect, it } from "vitest";

import { runtimeModeCapabilities } from "./runtimeMode";

describe("runtimeModeCapabilities", () => {
  it("exposes the fail-closed provider capability matrix", () => {
    expect([...runtimeModeCapabilities("codex")]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect([...runtimeModeCapabilities("claudeAgent")]).toEqual([
      "approval-required",
      "auto-accept-edits",
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
