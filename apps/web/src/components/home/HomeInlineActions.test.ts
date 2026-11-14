import { describe, expect, it } from "vitest";

import type { PendingApproval } from "../../session-logic";
import { approvalDenyDecision, approvalEnterDecision } from "./HomeInlineActions";

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: "request-1" as never,
    requestKind: "command",
    createdAt: "2026-03-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("approvalEnterDecision", () => {
  it("approves once, never for the session", () => {
    expect(approvalEnterDecision(approval())).toBe("accept");
  });

  it("is unbound when the provider wants No as the default", () => {
    expect(approvalEnterDecision(approval({ presentation: { defaultToNo: true } }))).toBeNull();
  });

  it("is unbound when the request offers no plain approval", () => {
    expect(
      approvalEnterDecision(
        approval({
          approvalOptions: [
            { decision: "decline", label: "No" },
            { decision: "acceptAlways", label: "Always allow" },
          ],
        }),
      ),
    ).toBeNull();
    // A stored MCP request without its options can only be declined or cancelled.
    expect(approvalEnterDecision(approval({ requestKind: "mcp-elicitation" }))).toBeNull();
  });

  it("is unbound for a permission request with no permissions to grant", () => {
    expect(approvalEnterDecision(approval({ requestKind: "permission" }))).toBeNull();
    expect(
      approvalEnterDecision(
        approval({ requestKind: "permission", requestedPermissions: { network: true } }),
      ),
    ).toBe("accept");
  });
});

describe("approvalDenyDecision", () => {
  it("declines when the request can be declined", () => {
    expect(approvalDenyDecision(approval())).toBe("decline");
    expect(approvalDenyDecision(approval({ requestKind: "mcp-elicitation" }))).toBe("decline");
    expect(approvalDenyDecision(approval({ presentation: { defaultToNo: true } }))).toBe("decline");
  });

  it("is unbound when the provider offers no decline", () => {
    expect(
      approvalDenyDecision(
        approval({ approvalOptions: [{ decision: "accept", label: "Continue" }] }),
      ),
    ).toBeNull();
  });
});
