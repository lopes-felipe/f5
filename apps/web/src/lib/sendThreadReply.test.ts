import { describe, expect, it } from "vitest";

import { buildThreadReplyCommand, type ThreadReplyTarget } from "./sendThreadReply";

const THREAD: ThreadReplyTarget = {
  id: "thread-1" as never,
  model: "claude-opus-4-6",
  modelSelection: { instanceId: "claude", model: "claude-opus-4-6" } as never,
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

describe("buildThreadReplyCommand", () => {
  it("sends the thread's own model and modes", () => {
    const command = buildThreadReplyCommand({ thread: THREAD, text: "Carry on" });
    expect(command).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-1",
      message: { role: "user", text: "Carry on", attachments: [] },
      model: "claude-opus-4-6",
      modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(command.sourceProposedPlan).toBeUndefined();
    expect(command.assistantDeliveryMode).toBeUndefined();
    expect(command.bootstrap).toBeUndefined();
  });

  it("leaves out a model selection the thread does not have", () => {
    const command = buildThreadReplyCommand({
      thread: { ...THREAD, modelSelection: undefined },
      text: "Carry on",
    });
    expect("modelSelection" in command).toBe(false);
  });

  it("names the plan only for a turn that implements it", () => {
    const planId = "plan-1" as never;
    expect(
      buildThreadReplyCommand({
        thread: THREAD,
        text: "Implement",
        interactionMode: "default",
        sourceProposedPlanId: planId,
      }),
    ).toMatchObject({
      interactionMode: "default",
      sourceProposedPlan: { threadId: "thread-1", planId: "plan-1" },
    });
    // A revision stays in plan mode and starts no implementation.
    expect(
      buildThreadReplyCommand({ thread: THREAD, text: "Revise", sourceProposedPlanId: planId })
        .sourceProposedPlan,
    ).toBeUndefined();
  });

  it("gives every command its own ids", () => {
    const first = buildThreadReplyCommand({ thread: THREAD, text: "One" });
    const second = buildThreadReplyCommand({ thread: THREAD, text: "Two" });
    expect(first.commandId).not.toBe(second.commandId);
    expect(first.message.messageId).not.toBe(second.message.messageId);
  });
});
