import { describe, expect, it } from "vitest";
import type { ComputerLeaseHolder } from "@t3tools/contracts";
import { ComputerExecutionAuthority } from "./ComputerExecutionAuthority";

const input = {
  profileId: "p",
  backendIncarnation: "i",
  threadId: "t",
  sessionGeneration: "s",
  policyRevision: 1,
  turnId: "turn",
  appId: "com.apple.calculator",
  grantVersion: 1,
};
function holder(
  receipt: string,
  overrides: Partial<ComputerLeaseHolder> = {},
): ComputerLeaseHolder {
  return {
    profileId: "p",
    threadId: "t",
    sessionGeneration: "s",
    turnId: "turn",
    executionGeneration: 7,
    grantVersion: 1,
    grants: [],
    backend: "native",
    threadTitle: "T",
    scope: { kind: "takeover", appId: "com.apple.calculator", approvalReceipt: receipt },
    policyRevision: 1,
    ...overrides,
  };
}
describe("computer execution receipts", () => {
  it("accepts only the exact bound takeover receipt", () => {
    const authority = new ComputerExecutionAuthority();
    const receipt = authority.issueTakeover(input);
    // Unbound: no generation yet.
    expect(authority.validTakeover(holder(receipt), "i")).toBe(false);
    authority.bindTakeover(receipt, 7);
    expect(authority.validTakeover(holder(receipt), "i")).toBe(true);
    // Rebinding cannot move a receipt to another generation.
    authority.bindTakeover(receipt, 8);
    expect(authority.validTakeover(holder(receipt, { executionGeneration: 8 }), "i")).toBe(false);
    // Forged, wrong owner, wrong target, wrong backend.
    expect(authority.validTakeover(holder("forged"), "i")).toBe(false);
    expect(authority.validTakeover(holder(receipt, { profileId: "other" }), "i")).toBe(false);
    expect(authority.validTakeover(holder(receipt, { turnId: "next" }), "i")).toBe(false);
    expect(
      authority.validTakeover(
        holder(receipt, {
          scope: { kind: "takeover", appId: "com.apple.Notes", approvalReceipt: receipt },
        }),
        "i",
      ),
    ).toBe(false);
    expect(authority.validTakeover(holder(receipt), "replaced")).toBe(false);
  });
  it("revokes stale receipts on policy, session and pause transitions", () => {
    const authority = new ComputerExecutionAuthority();
    const takeover = authority.issueTakeover(input);
    authority.bindTakeover(takeover, 7);
    authority.approveSession({ ...input });
    expect(authority.hasSessionApproval("p", "i", "t", "s")).toBe(true);
    authority.advanceRevision("p", "t", 2);
    expect(authority.validTakeover(holder(takeover), "i")).toBe(false);
    expect(authority.hasSessionApproval("p", "i", "t", "s")).toBe(false);
    expect(authority.revisionAccepted("p", "t", 1)).toBe(false);
    expect(authority.revisionAccepted("p", "t", 2)).toBe(true);
    authority.approveSession({ ...input, policyRevision: 2 });
    authority.sessionChanged("p", "t", "s2");
    expect(authority.hasSessionApproval("p", "i", "t", "s")).toBe(false);
    const next = authority.issueTakeover({ ...input, policyRevision: 2 });
    authority.bindTakeover(next, 9);
    authority.revokeTakeovers((receipt) => receipt.threadId === "t");
    expect(
      authority.validTakeover(holder(next, { executionGeneration: 9, policyRevision: 2 }), "i"),
    ).toBe(false);
  });
  it("binds session approval to the backend incarnation and drops a disconnected profile", () => {
    const authority = new ComputerExecutionAuthority();
    authority.approveSession({ ...input });
    expect(authority.hasSessionApproval("p", "other", "t", "s")).toBe(false);
    authority.disconnect("p");
    expect(authority.hasSessionApproval("p", "i", "t", "s")).toBe(false);
  });
});
