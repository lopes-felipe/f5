import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  applySnapshot: vi.fn(),
  setInteractionMode: vi.fn(),
  draftsByThreadId: {} as Record<string, { interactionMode?: string | null }>,
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ nextTurnQueue: { submit: mocks.submit } }),
}));
vi.mock("../nextTurnQueueStore", () => ({
  useNextTurnQueueStore: { getState: () => ({ applySnapshot: mocks.applySnapshot }) },
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      draftsByThreadId: mocks.draftsByThreadId,
      setInteractionMode: mocks.setInteractionMode,
    }),
  },
}));

import { WsRequestError } from "../wsTransport";
import {
  buildThreadReplyCommand,
  resetThreadRepliesForTests,
  sendThreadReply,
  type ThreadReplyTarget,
} from "./sendThreadReply";
import { UNCONFIRMED_SUBMISSION_TTL_MS } from "./unconfirmedSubmission";

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

describe("sendThreadReply", () => {
  const started = (submissionId: string) => ({ submissionId, disposition: "started", sequence: 1 });
  const submittedIds = () =>
    mocks.submit.mock.calls.map(([request]) => [
      request.submissionId,
      request.command.commandId,
      request.command.message.messageId,
    ]);

  beforeEach(() => {
    vi.useRealTimers();
    mocks.submit.mockReset();
    mocks.applySnapshot.mockReset();
    mocks.setInteractionMode.mockReset();
    mocks.draftsByThreadId = {};
    resetThreadRepliesForTests();
  });

  it("submits the command under its own id and reports what the server did", async () => {
    mocks.submit.mockImplementation(async ({ submissionId }) => started(submissionId));
    await expect(sendThreadReply({ thread: THREAD, text: "Carry on" })).resolves.toBe("started");
    const [request] = mocks.submit.mock.calls[0]!;
    expect(request.submissionId).toBe(request.command.commandId);
    expect(request.intent).toBe("auto");
    expect(mocks.applySnapshot).not.toHaveBeenCalled();

    mocks.submit.mockImplementation(async ({ submissionId }) => ({
      submissionId,
      disposition: "steered",
      sequence: 2,
    }));
    await expect(
      sendThreadReply({ thread: THREAD, text: "And this", intent: "queue-tail" }),
    ).resolves.toBe("steered");
    expect(mocks.submit.mock.calls[1]![0].intent).toBe("queue-tail");
  });

  it.each(["rejected", "canceled", "cleared"] as const)(
    "rejects a %s submission with the server's reason and sends a new command next time",
    async (disposition) => {
      mocks.submit.mockImplementation(async ({ submissionId }) => ({
        submissionId,
        disposition,
        reasonCode: "queue-full",
        detail: "The queue is full.",
      }));
      await expect(sendThreadReply({ thread: THREAD, text: "Carry on" })).rejects.toThrow(
        "The queue is full.",
      );
      mocks.submit.mockImplementation(async ({ submissionId }) => ({
        submissionId,
        disposition,
        reasonCode: "queue-full",
      }));
      await expect(sendThreadReply({ thread: THREAD, text: "Carry on" })).rejects.toThrow(
        "The message was not accepted.",
      );
      // The server answered: the same text is a new message, not a replay of the refused one.
      const [first, second] = submittedIds();
      expect(second![0]).not.toBe(first![0]);
      expect(mocks.setInteractionMode).not.toHaveBeenCalled();
    },
  );

  it("refuses a message past the composer's limits before sending anything", async () => {
    await expect(sendThreadReply({ thread: THREAD, text: "x".repeat(120_001) })).rejects.toThrow(
      /exceeds the 120,000 character provider input limit/,
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("shows a queued reply in the thread's queue and leaves the composer's mode alone", async () => {
    const snapshot = { threadId: THREAD.id, revision: 3, items: [] };
    mocks.draftsByThreadId = { [THREAD.id]: { interactionMode: "default" } };
    mocks.submit.mockImplementation(async ({ submissionId }) => ({
      submissionId,
      disposition: "queued",
      itemId: submissionId,
      snapshot,
    }));
    await expect(sendThreadReply({ thread: THREAD, text: "Later" })).resolves.toBe("queued");
    expect(mocks.applySnapshot).toHaveBeenCalledWith(snapshot);
    // No turn ran in plan mode yet; a cancelled item must not have changed the composer.
    expect(mocks.setInteractionMode).not.toHaveBeenCalled();
  });

  it("moves the thread composer's mode to the one the turn started in", async () => {
    mocks.submit.mockImplementation(async ({ submissionId }) => started(submissionId));
    mocks.draftsByThreadId = { [THREAD.id]: { interactionMode: "plan" } };
    await sendThreadReply({ thread: THREAD, text: "Implement", interactionMode: "default" });
    expect(mocks.setInteractionMode).toHaveBeenCalledExactlyOnceWith(THREAD.id, "default");

    // Nothing to change when the composer has no mode of its own, or already agrees.
    mocks.setInteractionMode.mockReset();
    mocks.draftsByThreadId = {};
    await sendThreadReply({ thread: THREAD, text: "Again", interactionMode: "default" });
    mocks.draftsByThreadId = { [THREAD.id]: { interactionMode: "default" } };
    await sendThreadReply({ thread: THREAD, text: "Once more", interactionMode: "default" });
    expect(mocks.setInteractionMode).not.toHaveBeenCalled();
  });

  it.each([
    "Request timed out: nextTurnQueue.submit",
    "WebSocket connection closed.",
    "WebSocket connection timed out.",
  ])("resends the same command after a response was lost (%s)", async (message) => {
    // The server took the message, but its answer never arrived.
    mocks.submit.mockRejectedValueOnce(new Error(message));
    await expect(sendThreadReply({ thread: THREAD, text: "Carry on" })).rejects.toThrow(message);
    mocks.submit.mockImplementation(async ({ submissionId }) => started(submissionId));
    await expect(sendThreadReply({ thread: THREAD, text: "Carry on" })).resolves.toBe("started");
    const [first, second] = submittedIds();
    expect(second).toEqual(first);

    // Confirmed now: the same words later are a new message.
    await sendThreadReply({ thread: THREAD, text: "Carry on" });
    expect(submittedIds()[2]![0]).not.toBe(first![0]);
  });

  it("sends one command for the same reply sent twice at once", async () => {
    const answers: Array<() => void> = [];
    mocks.submit.mockImplementation(
      ({ submissionId }) =>
        new Promise((resolve) => {
          answers.push(() => resolve(started(submissionId)));
        }),
    );
    const first = sendThreadReply({ thread: THREAD, text: "Implement" });
    const second = sendThreadReply({ thread: THREAD, text: "Implement" });
    const [firstIds, secondIds] = submittedIds();
    expect(secondIds).toEqual(firstIds);
    for (const answer of answers) answer();
    await expect(Promise.all([first, second])).resolves.toEqual(["started", "started"]);
  });

  it("does not reuse an unconfirmed command for a different message, thread or mode", async () => {
    mocks.submit.mockRejectedValue(new Error("WebSocket connection closed."));
    const attempt = (input: Parameters<typeof sendThreadReply>[0]) =>
      sendThreadReply(input).catch(() => {});
    await attempt({ thread: THREAD, text: "Carry on" });
    await attempt({ thread: THREAD, text: "Carry on, please" });
    await attempt({ thread: THREAD, text: "Carry on, please", interactionMode: "default" });
    await attempt({ thread: THREAD, text: "Carry on, please", interactionMode: "default" });
    await attempt({
      thread: { ...THREAD, id: "thread-2" as never },
      text: "Carry on, please",
      interactionMode: "default",
    });
    const ids = submittedIds().map(([submissionId]) => submissionId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(ids[3]).toBe(ids[2]);
    expect(ids[4]).not.toBe(ids[3]);
  });

  it("sends a new command when the failure is certain", async () => {
    const certain = [
      // The server answered with an error.
      new WsRequestError("Thread not found.", "NotFound", undefined, false, undefined, "server"),
      // The transport never sent it.
      new WsRequestError("Not ready.", "ConnectionNotReady", undefined, true),
      new WsRequestError(
        "Request timed out before it was sent: nextTurnQueue.submit",
        "QueueExpired",
        undefined,
        true,
      ),
    ];
    for (const error of certain) {
      mocks.submit.mockReset();
      mocks.submit.mockRejectedValueOnce(error);
      await expect(sendThreadReply({ thread: THREAD, text: "Carry on" })).rejects.toBe(error);
      mocks.submit.mockImplementation(async ({ submissionId }) => started(submissionId));
      await sendThreadReply({ thread: THREAD, text: "Carry on" });
      const [first, second] = submittedIds();
      expect(second![0]).not.toBe(first![0]);
    }
  });

  it("treats the same words as a new message once the lost send is old", async () => {
    vi.useFakeTimers();
    mocks.submit.mockRejectedValueOnce(new Error("WebSocket connection closed."));
    await expect(sendThreadReply({ thread: THREAD, text: "continue" })).rejects.toThrow();
    vi.advanceTimersByTime(UNCONFIRMED_SUBMISSION_TTL_MS);
    mocks.submit.mockImplementation(async ({ submissionId }) => started(submissionId));
    await sendThreadReply({ thread: THREAD, text: "continue" });
    const [first, second] = submittedIds();
    expect(second![0]).not.toBe(first![0]);
  });
});
