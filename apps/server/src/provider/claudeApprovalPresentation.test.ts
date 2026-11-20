import { describe, expect, it } from "vitest";
import {
  claudeApprovalPresentation,
  claudeRemovalSafetyDenial,
  effectiveClaudeApprovalDecision,
} from "./claudeApprovalPresentation.ts";

describe("Claude approval presentation", () => {
  it.each([
    "Dangerous rm command. Use a safer path.",
    "Dangerous rmdir command.",
    "This shell -c script runs rm and could not be checked",
    "A permission rule denies a command in this shell -c script",
    "\u001b[31mDangerous rm command.\u001b[0m",
  ])("returns removal warnings as safety denials in bypass mode: %s", (decisionReason) => {
    const result = claudeRemovalSafetyDenial("Bash", "bypassPermissions", {
      decisionReason,
      toolUseID: "removal",
    });
    expect(result).toMatchObject({ behavior: "deny", toolUseID: "removal" });
    if (result?.behavior !== "deny") throw new Error("Expected a safety denial");
    expect(result.message).toContain("the user did not reject it");
    expect(result.message).toContain("safe rewrite");
    expect(result.message).not.toContain("\u001b");
  });

  it("retains explicit ask rules and non-bypass approvals", () => {
    const options = { decisionReason: "Dangerous rm command.", toolUseID: "removal" };
    expect(claudeRemovalSafetyDenial("Bash", "default", options)).toBeUndefined();
    expect(claudeRemovalSafetyDenial("Read", "bypassPermissions", options)).toBeUndefined();
    expect(
      claudeRemovalSafetyDenial("Bash", "bypassPermissions", {
        ...options,
        matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "rm *" },
      }),
    ).toBeUndefined();
    expect(
      claudeRemovalSafetyDenial("Bash", "bypassPermissions", {
        ...options,
        decisionReason: "Outside the workspace",
      }),
    ).toBeUndefined();
  });
  it("copies the SDK prompt metadata and omits empty fields", () => {
    expect(
      claudeApprovalPresentation({
        title: " Claude wants to read foo.txt ",
        description: "",
        displayName: "Read file",
        decisionReason: "Outside the working directory",
        blockedPath: "/etc/foo.txt",
        agentID: "agent-1",
        defaultToNo: true,
        suppressAlwaysAllowRule: false,
      }),
    ).toEqual({
      title: "Claude wants to read foo.txt",
      displayName: "Read file",
      decisionReason: "Outside the working directory",
      blockedPath: "/etc/foo.txt",
      agentId: "agent-1",
      defaultToNo: true,
    });
    expect(claudeApprovalPresentation({})).toBeUndefined();
  });

  it("suppresses the session accept when it would grant nothing", () => {
    expect(claudeApprovalPresentation({}, { sessionGrantAvailable: false })).toEqual({
      suppressAlwaysAllowRule: true,
    });
    expect(claudeApprovalPresentation({}, { sessionGrantAvailable: true })).toBeUndefined();
    expect(
      claudeApprovalPresentation(
        { suppressAlwaysAllowRule: true },
        { sessionGrantAvailable: true },
      ),
    ).toEqual({ suppressAlwaysAllowRule: true });
  });

  it("downgrades persistent accepts when the ask suppresses always-allow rules", () => {
    const presentation = { suppressAlwaysAllowRule: true };
    expect(effectiveClaudeApprovalDecision("acceptForSession", presentation)).toBe("accept");
    expect(effectiveClaudeApprovalDecision("acceptAlways", presentation)).toBe("accept");
    expect(effectiveClaudeApprovalDecision("decline", presentation)).toBe("decline");
    expect(effectiveClaudeApprovalDecision("acceptForSession", undefined)).toBe("acceptForSession");
  });
});
