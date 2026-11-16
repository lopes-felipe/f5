import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { computerPolicyChange } from "./computerPolicyChange";

const current = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: { one: { enableAgentComputerUse: true } },
} as unknown as ServerSettings;

describe("computer policy change detection", () => {
  it("ignores patches that leave computer policy unchanged", () => {
    expect(computerPolicyChange(current, {})).toBeNull();
    expect(
      computerPolicyChange(current, {
        enableAgentComputerUse: current.enableAgentComputerUse,
        computerUseExecutionMode: current.computerUseExecutionMode,
        computerUsePasswordMasking: current.computerUsePasswordMasking,
      }),
    ).toBeNull();
    // An unrelated project override edit keeps running agents untouched.
    expect(
      computerPolicyChange(current, {
        projectSettingsOverrides: { one: { enableAgentComputerUse: true, worktreeCleanup: null } },
      }),
    ).toBeNull();
  });
  it("scopes project override changes to that project and global changes to everyone", () => {
    expect(computerPolicyChange(current, { computerUsePasswordMasking: "conservative" })).toEqual({
      global: true,
    });
    expect(
      computerPolicyChange(current, {
        projectSettingsOverrides: { one: null, two: { enableAgentBrowserAccess: false } },
      }),
    ).toEqual({ global: false, projects: new Set(["one", "two"]) });
    expect(
      computerPolicyChange(current, {
        computerUseExecutionMode:
          current.computerUseExecutionMode === "background" ? "foreground" : "background",
      }),
    ).toEqual({ global: true });
  });
});
