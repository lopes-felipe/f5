import { describe, expect, it } from "vitest";
import {
  codexCommandApprovalDecision,
  codexCommandApprovalOptions,
  readCodexCommandApprovalOffer,
} from "./commandApprovalOffer.ts";

describe("Codex command approval offers", () => {
  it("keeps the default buttons when the server offers nothing extra", () => {
    const offer = readCodexCommandApprovalOffer({ command: "ls" });
    expect(codexCommandApprovalOptions(offer)).toBeUndefined();
    expect(codexCommandApprovalDecision(offer, "acceptForSession")).toBe("acceptForSession");
    expect(() => codexCommandApprovalDecision(offer, "acceptAlways")).toThrow();
  });

  it("advertises only offered decisions and a single amendment prefix", () => {
    const offer = readCodexCommandApprovalOffer({
      proposedExecpolicyAmendment: ["npm", "run", "test"],
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "run", "test"] } },
        {
          applyNetworkPolicyAmendment: { network_policy_amendment: { host: "x", action: "allow" } },
        },
        "cancel",
      ],
    });
    expect(codexCommandApprovalOptions(offer)?.map((option) => option.decision)).toEqual([
      "cancel",
      "acceptAlways",
      "accept",
    ]);
    expect(codexCommandApprovalOptions(offer)?.[1]?.label).toBe("Always allow `npm run test`");
    expect(() => codexCommandApprovalDecision(offer, "decline")).toThrow("does not offer");
  });

  it("offers the proposed prefix on servers without a decision list", () => {
    const offer = readCodexCommandApprovalOffer({ proposedExecpolicyAmendment: ["rg", "a b"] });
    expect(codexCommandApprovalOptions(offer)?.map((option) => option.decision)).toEqual([
      "cancel",
      "decline",
      "acceptForSession",
      "acceptAlways",
      "accept",
    ]);
    expect(codexCommandApprovalOptions(offer)?.[3]?.label).toBe('Always allow `rg "a b"`');
    expect(codexCommandApprovalDecision(offer, "acceptAlways")).toEqual({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rg", "a b"] },
    });
  });

  it("drops conflicting or malformed amendment offers", () => {
    const offer = readCodexCommandApprovalOffer({
      availableDecisions: [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } },
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "push"] } },
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: [1] } },
        "decline",
      ],
    });
    expect(offer.execpolicyAmendment).toEqual(["git", "status"]);
    expect(codexCommandApprovalDecision(offer, "acceptAlways")).toEqual({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] },
    });
  });
});
