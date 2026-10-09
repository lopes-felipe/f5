import { describe, expect, it } from "vitest";
import { ThreadId, type ComputerAccessPush } from "@t3tools/contracts";
import { computerAccessAnswer, initialComputerAccessDecisions } from "./ComputerAccessCard.logic";
const request: typeof ComputerAccessPush.Type = {
  requestId: "request",
  threadId: ThreadId.makeUnsafe("thread"),
  backendIncarnation: "backend",
  reason: "Edit apps",
  kind: "apps",
  apps: [
    { appId: "f5", name: "F5", tier: "blocked" },
    { appId: "terminal", name: "Terminal", tier: "click" },
    { appId: "notes", name: "Notes", tier: "full" },
  ],
};
describe("computer consent decisions", () => {
  it("defaults to allowing grantable apps without typing or remembering", () => {
    expect(initialComputerAccessDecisions(request)).toEqual([
      { appId: "f5", allow: false, allowTyping: false, remember: false },
      { appId: "terminal", allow: true, allowTyping: false, remember: false },
      { appId: "notes", allow: true, allowTyping: false, remember: false },
    ]);
  });
  it("narrows answers to requested apps and typing to click tier", () => {
    const decisions = [
      ...initialComputerAccessDecisions(request),
      { appId: "foreign", allow: true, allowTyping: true, remember: true },
    ].map((entry) => ({ ...entry, allow: true, allowTyping: true, remember: true }));
    expect(computerAccessAnswer(request, decisions, true).decisions).toEqual([
      { appId: "f5", allow: false, allowTyping: false, remember: false },
      { appId: "terminal", allow: true, allowTyping: true, remember: true },
      { appId: "notes", allow: true, allowTyping: false, remember: true },
    ]);
    expect(
      computerAccessAnswer(request, decisions, false).decisions.every(
        (entry) => !entry.allow && !entry.allowTyping && !entry.remember,
      ),
    ).toBe(true);
  });
  it("answers session actions explicitly", () => {
    expect(
      computerAccessAnswer({ ...request, kind: "session-actions", apps: [] }, [], false),
    ).toMatchObject({ allowSessionActions: false, backendIncarnation: "backend" });
  });
});
