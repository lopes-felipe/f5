import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyRewindUiEvent,
  EMPTY_REWIND_UI_STATE,
  type PendingRewind,
  type RewindUiState,
} from "./rewindUi.logic";

const threadId = ThreadId.makeUnsafe("thread-1");
const targetMessageId = MessageId.makeUnsafe("message-user-2");
const operationId = CommandId.makeUnsafe("rewind-op-1");
const noPrompt = () => null;

function makeEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-10-01T10:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as OrchestrationEvent;
}

function failedActivity(payload: Record<string, unknown>): OrchestrationEvent {
  return makeEvent("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.makeUnsafe("rewind-failed-1"),
      tone: "error",
      kind: "conversation.rewind.failed",
      summary: "Conversation rewind could not start",
      payload,
      turnId: null,
      createdAt: "2026-10-01T10:00:01.000Z",
    },
  } as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>["payload"]);
}

const pending: PendingRewind = {
  operationId,
  threadId,
  targetMessageId,
  restoreFiles: true,
  changedFileCount: 2,
  prompt: { text: "Fix the bug", attachments: [] },
  requestedAt: "2026-10-01T09:59:59.000Z",
};

const withPending: RewindUiState = {
  ...EMPTY_REWIND_UI_STATE,
  pendingByThreadId: { [threadId]: pending },
};

describe("applyRewindUiEvent", () => {
  it("records a revert requested elsewhere, capturing its prompt", () => {
    const result = applyRewindUiEvent(
      EMPTY_REWIND_UI_STATE,
      makeEvent("thread.conversation-revert-requested", {
        type: "thread.conversation.revert",
        commandId: CommandId.makeUnsafe("command-1"),
        operationId,
        threadId,
        targetMessageId,
        restoreFiles: false,
        createdAt: "2026-10-01T10:00:00.000Z",
      }),
      () => ({ text: "Captured", attachments: [] }),
    );
    expect(result.state.pendingByThreadId[threadId]).toMatchObject({
      operationId,
      targetMessageId,
      restoreFiles: false,
      prompt: { text: "Captured" },
    });
    expect(result.effect).toBeNull();
  });

  it("keeps the optimistic entry when its own request event arrives", () => {
    const result = applyRewindUiEvent(
      withPending,
      makeEvent("thread.conversation-revert-requested", {
        type: "thread.conversation.revert",
        commandId: CommandId.makeUnsafe("command-1"),
        operationId,
        threadId,
        targetMessageId,
        restoreFiles: true,
        createdAt: "2026-10-01T10:00:00.000Z",
      }),
      noPrompt,
    );
    expect(result.state).toBe(withPending);
  });

  it("moves a matching revert from pending to landed and announces it", () => {
    const result = applyRewindUiEvent(
      withPending,
      makeEvent("thread.reverted", { threadId, operationId, turnCount: 1 }),
      noPrompt,
    );
    expect(result.state.pendingByThreadId[threadId]).toBeUndefined();
    expect(result.state.landedByThreadId[threadId]).toMatchObject({
      operationId,
      prompt: { text: "Fix the bug" },
      landedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(result.effect).toMatchObject({ kind: "reverted", rewind: { changedFileCount: 2 } });
  });

  it("ignores checkpoint reverts and other operations", () => {
    for (const event of [
      makeEvent("thread.reverted", { threadId, turnCount: 1 }),
      makeEvent("thread.reverted", {
        threadId,
        operationId: CommandId.makeUnsafe("other-op"),
        turnCount: 1,
      }),
    ]) {
      const result = applyRewindUiEvent(withPending, event, noPrompt);
      expect(result.state).toBe(withPending);
      expect(result.effect).toBeNull();
    }
  });

  it("clears pending, landed and hidden state when the draft is resolved", () => {
    const state: RewindUiState = {
      ...withPending,
      landedByThreadId: { [threadId]: { ...pending, landedAt: "2026-10-01T10:00:00.000Z" } },
      hiddenDraftOperationIds: { [operationId]: true },
    };
    const result = applyRewindUiEvent(
      state,
      makeEvent("thread.rewind-draft-resolved", { threadId, operationId, intent: "cancel" }),
      noPrompt,
    );
    expect(result.state.pendingByThreadId).toEqual({});
    expect(result.state.landedByThreadId).toEqual({});
    expect(result.state.hiddenDraftOperationIds).toEqual({});
  });

  it("ends the pending revert on a preflight failure and offers a keep-files retry", () => {
    const result = applyRewindUiEvent(
      withPending,
      failedActivity({
        detail: "The file checkpoint for this boundary is unavailable.",
        operationId,
        targetMessageId,
        restoreFiles: true,
        stage: "preflight",
      }),
      noPrompt,
    );
    expect(result.state.pendingByThreadId[threadId]).toBeUndefined();
    expect(result.effect).toEqual({
      kind: "failed",
      threadId,
      detail: "The file checkpoint for this boundary is unavailable.",
      preflight: true,
      targetMessageId,
      restoreFiles: true,
    });
  });

  it("treats failures after preparation as panel-explained, not preflight", () => {
    const result = applyRewindUiEvent(
      withPending,
      failedActivity({ detail: "Timed out", operationId, stage: "prepared" }),
      noPrompt,
    );
    expect(result.state.pendingByThreadId[threadId]).toBeUndefined();
    expect(result.effect).toMatchObject({ kind: "failed", preflight: false });
  });

  it("keeps a different operation pending when another one fails", () => {
    const result = applyRewindUiEvent(
      withPending,
      failedActivity({ detail: "x", operationId: "other-op", stage: "preflight" }),
      noPrompt,
    );
    expect(result.state.pendingByThreadId[threadId]).toBe(pending);
  });
});
