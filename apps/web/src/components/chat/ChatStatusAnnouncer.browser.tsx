import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  ChatStatusAnnouncer,
  deriveChatStatusOutcome,
  type ChatStatusOutcome,
} from "./ChatStatusAnnouncer";

interface AnnouncerProps {
  threadId: string;
  turnId: string | null;
  outcome: ChatStatusOutcome;
  attentionRequestId?: string | null;
}

async function mount(initial: AnnouncerProps) {
  const host = document.body.appendChild(document.createElement("div"));
  const screen = await render(<ChatStatusAnnouncer {...initial} />, { container: host });
  const rawRegion = () => host.querySelector('[aria-live="polite"]')?.textContent ?? null;
  const region = () => rawRegion()?.replace(/ $/, "") ?? null;
  const update = (next: AnnouncerProps) => screen.rerender(<ChatStatusAnnouncer {...next} />);
  return { region, rawRegion, update };
}

describe("deriveChatStatusOutcome", () => {
  const base = {
    isWorking: false,
    hasPendingApproval: false,
    hasBlockingUserInput: false,
    latestTurnState: null,
  } as const;

  it("reports the turn's actual outcome", () => {
    expect(deriveChatStatusOutcome({ ...base, latestTurnState: "completed" })).toBe("completed");
    expect(deriveChatStatusOutcome({ ...base, latestTurnState: "error" })).toBe("failed");
    expect(deriveChatStatusOutcome({ ...base, latestTurnState: "interrupted" })).toBe(
      "interrupted",
    );
    expect(deriveChatStatusOutcome({ ...base, isWorking: true })).toBe("working");
    expect(deriveChatStatusOutcome(base)).toBe("idle");
  });

  it("puts waiting for the user ahead of working", () => {
    expect(deriveChatStatusOutcome({ ...base, isWorking: true, hasPendingApproval: true })).toBe(
      "awaiting-approval",
    );
    expect(deriveChatStatusOutcome({ ...base, isWorking: true, hasBlockingUserInput: true })).toBe(
      "awaiting-input",
    );
  });
});

describe("ChatStatusAnnouncer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("announces a failure as a failure, not as a ready response", async () => {
    const { region, update } = await mount({ threadId: "a", turnId: null, outcome: "idle" });
    expect(region()).toBe("");
    await update({ threadId: "a", turnId: "t1", outcome: "working" });
    expect(region()).toBe("Working");
    await update({ threadId: "a", turnId: "t1", outcome: "failed" });
    expect(region()).toBe("Response failed");
  });

  it("announces approvals and interruptions", async () => {
    const { region, update } = await mount({ threadId: "a", turnId: "t1", outcome: "working" });
    await update({ threadId: "a", turnId: "t1", outcome: "awaiting-approval" });
    expect(region()).toBe("Waiting for your approval");
    await update({ threadId: "a", turnId: "t1", outcome: "working" });
    await update({ threadId: "a", turnId: "t1", outcome: "interrupted" });
    expect(region()).toBe("Response stopped");
  });

  it("does not replay on thread switches or when an outcome reappears", async () => {
    const { region, update } = await mount({ threadId: "a", turnId: "t1", outcome: "working" });
    await update({ threadId: "a", turnId: "t1", outcome: "completed" });
    expect(region()).toBe("Response ready");

    await update({ threadId: "b", turnId: "t9", outcome: "completed" });
    expect(region()).toBe("");
    await update({ threadId: "b", turnId: "t9", outcome: "idle" });
    await update({ threadId: "b", turnId: "t9", outcome: "completed" });
    expect(region()).toBe("");

    await update({ threadId: "b", turnId: "t10", outcome: "working" });
    expect(region()).toBe("Working");
    await update({ threadId: "b", turnId: "t10", outcome: "completed" });
    expect(region()).toBe("Response ready");
  });

  it("announces every approval in one turn, including back-to-back requests", async () => {
    const { region, rawRegion, update } = await mount({
      threadId: "a",
      turnId: "t1",
      outcome: "working",
    });
    const approval = (requestId: string) =>
      update({
        threadId: "a",
        turnId: "t1",
        outcome: "awaiting-approval",
        attentionRequestId: requestId,
      });

    await approval("r1");
    expect(region()).toBe("Waiting for your approval");
    await update({ threadId: "a", turnId: "t1", outcome: "working" });
    expect(region()).toBe("Working");
    await approval("r2");
    expect(region()).toBe("Waiting for your approval");

    const before = rawRegion();
    await approval("r3");
    expect(region()).toBe("Waiting for your approval");
    expect(rawRegion()).not.toBe(before);
  });

  it("announces the next turn after a completed one, even while the send is pending", async () => {
    const { region, update } = await mount({ threadId: "a", turnId: "t1", outcome: "working" });
    await update({ threadId: "a", turnId: "t1", outcome: "completed" });
    expect(region()).toBe("Response ready");

    // The send is busy before the new turn id arrives.
    await update({ threadId: "a", turnId: "t1", outcome: "working" });
    expect(region()).toBe("Working");
    await update({ threadId: "a", turnId: "t2", outcome: "working" });
    await update({ threadId: "a", turnId: "t2", outcome: "completed" });
    expect(region()).toBe("Response ready");
  });
});
