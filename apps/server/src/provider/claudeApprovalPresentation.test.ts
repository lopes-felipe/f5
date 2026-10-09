import { describe, expect, it } from "vitest";
import {
  claudeApprovalPresentation,
  effectiveClaudeApprovalDecision,
} from "./claudeApprovalPresentation.ts";

describe("Claude approval presentation", () => {
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

  it("downgrades persistent accepts when the ask suppresses always-allow rules", () => {
    const presentation = { suppressAlwaysAllowRule: true };
    expect(effectiveClaudeApprovalDecision("acceptForSession", presentation)).toBe("accept");
    expect(effectiveClaudeApprovalDecision("acceptAlways", presentation)).toBe("accept");
    expect(effectiveClaudeApprovalDecision("decline", presentation)).toBe("decline");
    expect(effectiveClaudeApprovalDecision("acceptForSession", undefined)).toBe("acceptForSession");
  });
});
