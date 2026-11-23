import { describe, expect, it } from "vitest";

import {
  runtimeModeCapabilities,
  runtimeModeUnsupportedReason,
  savedRuntimeModeUnsupportedReason,
  supportedRuntimeModeAtOrBelow,
} from "./runtimeMode";

describe("snapshot runtime modes", () => {
  it("lets a snapshot narrow its kind's table and widen only where the kind allows", () => {
    expect([
      ...runtimeModeCapabilities("antigravity", ["approval-required", "auto-accept-edits", "auto"]),
    ]).toEqual(["approval-required", "auto-accept-edits", "auto"]);
    // Cursor never offers Auto or Auto-accept edits, whatever a snapshot claims.
    expect([...runtimeModeCapabilities("cursor", ["auto", "full-access"])]).toEqual([
      "full-access",
    ]);
    // Nothing allowed in the list: the kind's own table.
    expect([...runtimeModeCapabilities("grok", ["auto"])]).toEqual([
      "approval-required",
      "full-access",
    ]);
  });
});

describe("savedRuntimeModeUnsupportedReason", () => {
  it("lets saved Antigravity Auto resume without the snapshot, and nothing else", () => {
    // An update or a pending discovery: the snapshot doesn't offer Auto right now.
    expect(savedRuntimeModeUnsupportedReason("antigravity", "auto", [])).toBeUndefined();
    expect(runtimeModeUnsupportedReason("antigravity", "auto", [])).toBeDefined();
    // Other providers and modes keep the strict rule.
    expect(savedRuntimeModeUnsupportedReason("cursor", "auto")).toBeDefined();
    expect(savedRuntimeModeUnsupportedReason("grok", "auto-accept-edits")).toBeDefined();
  });
});

describe("supportedRuntimeModeAtOrBelow", () => {
  it("keeps a supported mode and otherwise narrows, never widens", () => {
    const antigravity = runtimeModeCapabilities("antigravity");
    expect(supportedRuntimeModeAtOrBelow(antigravity, "auto-accept-edits")).toBe(
      "auto-accept-edits",
    );
    // Auto is not offered: the next narrower mode, not Full access.
    expect(supportedRuntimeModeAtOrBelow(antigravity, "auto")).toBe("auto-accept-edits");
    expect(supportedRuntimeModeAtOrBelow(runtimeModeCapabilities("cursor"), "auto")).toBe(
      "approval-required",
    );
    // Muse has nothing at or below Supervised: the caller must ask.
    expect(
      supportedRuntimeModeAtOrBelow(runtimeModeCapabilities("muse"), "approval-required"),
    ).toBeUndefined();
  });
});

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
