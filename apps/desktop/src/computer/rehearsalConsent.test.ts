import { describe, expect, it } from "vitest";
import type { ComputerAccessRequested } from "@t3tools/contracts";
import { rehearsalAccessAnswer } from "./rehearsalConsent";

const request: ComputerAccessRequested = {
  requestId: "request",
  threadId: "thread",
  reason: "Test",
  kind: "apps",
  apps: [{ appId: "fixture", name: "Fixture", tier: "full" }],
};
describe("synthetic rehearsal consent", () => {
  it("allows only the exact fixture and never remembers grants", () => {
    expect(rehearsalAccessAnswer(request, "incarnation", "fixture")).toMatchObject({
      backendIncarnation: "incarnation",
      decisions: [{ appId: "fixture", allow: true, allowTyping: false, remember: false }],
      allowSessionActions: false,
    });
  });
  it.each(["user-app", "fixture-lookalike", "com.github.Electron"])(
    "refuses %s even when named Fixture",
    (appId) => {
      const answer = rehearsalAccessAnswer(
        { ...request, apps: [{ ...request.apps[0]!, appId }] },
        "incarnation",
        "fixture",
      );
      expect(answer.decisions.every((decision) => !decision.allow)).toBe(true);
    },
  );
  it("refuses the entire request if a user app is mixed with the fixture", () => {
    const answer = rehearsalAccessAnswer(
      { ...request, apps: [...request.apps, { appId: "other", name: "Other", tier: "full" }] },
      "incarnation",
      "fixture",
    );
    expect(answer.decisions.every((decision) => !decision.allow)).toBe(true);
  });
  it("does not turn a blocked fixture identity into a grant", () => {
    expect(
      rehearsalAccessAnswer(
        { ...request, apps: [{ ...request.apps[0]!, tier: "blocked" }] },
        "incarnation",
        "fixture",
      ).decisions[0]?.allow,
    ).toBe(false);
  });
  it("approves session actions only on an empty session-actions card", () => {
    expect(
      rehearsalAccessAnswer({ ...request, kind: "session-actions", apps: [] }, "i", "fixture")
        .allowSessionActions,
    ).toBe(true);
    expect(
      rehearsalAccessAnswer({ ...request, kind: "session-actions" }, "i", "fixture")
        .allowSessionActions,
    ).toBe(false);
  });
});
