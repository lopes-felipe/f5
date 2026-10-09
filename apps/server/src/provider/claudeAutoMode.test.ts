import { describe, expect, it } from "vitest";

import {
  claudeAutoModeRecheck,
  claudeAutoModeRejected,
  claudeRuntimePermissionMode,
} from "./claudeAutoMode.ts";

describe("claudeRuntimePermissionMode", () => {
  it("uses auto only with explicit model support", () => {
    expect(claudeRuntimePermissionMode("auto", true)).toEqual({
      mode: "auto",
      autoUnavailable: false,
    });
    for (const support of [false, undefined])
      expect(claudeRuntimePermissionMode("auto", support)).toEqual({
        mode: "default",
        autoUnavailable: true,
      });
    expect(claudeRuntimePermissionMode("approval-required", true).mode).toBe("default");
  });
});

describe("claudeAutoModeRejected (escalation fixtures)", () => {
  const cases: ReadonlyArray<[unknown, boolean]> = [
    ["auto", false],
    ["plan", false],
    ["default", true],
    ["acceptEdits", true],
    ["bypassPermissions", true],
    ["dontAsk", true],
    [undefined, false],
    [42, false],
  ];
  it.each(cases)("reported %s while auto was requested -> reject=%s", (reported, rejected) => {
    expect(claudeAutoModeRejected({ base: "auto", reported, workflow: false })).toBe(rejected);
  });

  it("ignores reports when auto is not the base or the session is a workflow", () => {
    expect(
      claudeAutoModeRejected({ base: "default", reported: "bypassPermissions", workflow: false }),
    ).toBe(false);
    expect(claudeAutoModeRejected({ base: "auto", reported: "default", workflow: true })).toBe(
      false,
    );
  });
});

describe("claudeAutoModeRecheck", () => {
  const base = { autoRequested: true, livePlan: false, workflow: false } as const;

  it("downgrades on an unsupported model and restores on a supported one", () => {
    expect(claudeAutoModeRecheck({ ...base, base: "auto", supportsAutoMode: false })).toEqual({
      base: "default",
      setLive: "default",
      downgraded: true,
    });
    expect(claudeAutoModeRecheck({ ...base, base: "default", supportsAutoMode: true })).toEqual({
      base: "auto",
      setLive: "auto",
      downgraded: false,
    });
    expect(
      claudeAutoModeRecheck({ ...base, base: "auto", supportsAutoMode: true }),
    ).toBeUndefined();
  });

  it("only moves the base mode in plan and never touches workflows", () => {
    expect(
      claudeAutoModeRecheck({ ...base, livePlan: true, base: "auto", supportsAutoMode: false }),
    ).toEqual({ base: "default", setLive: undefined, downgraded: true });
    expect(
      claudeAutoModeRecheck({ ...base, workflow: true, base: "plan", supportsAutoMode: false }),
    ).toBeUndefined();
    expect(
      claudeAutoModeRecheck({
        ...base,
        autoRequested: false,
        base: "default",
        supportsAutoMode: true,
      }),
    ).toBeUndefined();
  });
});
