import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type NextTurnQueueItem,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { NextTurnQueueStore } from "./nextTurnQueue.ts";
import { drainNextTurnQueue, resolveNextTurnQueueGate } from "./nextTurnQueueDrainer.ts";

const threadId = ThreadId.makeUnsafe("queue-gate-thread");

function queueItem(overrides: Partial<NextTurnQueueItem> = {}): NextTurnQueueItem {
  return {
    itemId: CommandId.makeUnsafe("queue-gate-item"),
    threadId,
    position: 0,
    status: "queued",
    allowAfterError: false,
    command: {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("queue-gate-command"),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe("queue-gate-message"),
        role: "user",
        text: "Continue",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: "queue-project" as OrchestrationThread["projectId"],
    title: "Queue thread",
    model: "gpt-5.1-codex",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    proposedPlans: [],
    compaction: null,
    sessionNotes: null,
    threadReferences: [],
    session: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastInteractionAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("resolveNextTurnQueueGate", () => {
  it("waits while a turn is running", () => {
    const active = thread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-running"),
        state: "running",
        requestedAt: "2026-01-01T00:00:00.500Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    expect(resolveNextTurnQueueGate(active, queueItem())).toEqual({
      kind: "wait",
      reason: "Waiting for the active turn to finish.",
    });
  });

  it("pauses after errors until explicitly resumed", () => {
    const failed = thread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-failed"),
        state: "error",
        requestedAt: "2026-01-01T00:00:00.500Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        assistantMessageId: null,
      },
    });
    expect(resolveNextTurnQueueGate(failed, queueItem()).kind).toBe("pause");
    expect(resolveNextTurnQueueGate(failed, queueItem({ allowAfterError: true })).kind).toBe(
      "ready",
    );
  });

  it("pauses missing, archived, and explicitly paused queues", () => {
    expect(resolveNextTurnQueueGate(undefined, queueItem()).kind).toBe("pause");
    expect(
      resolveNextTurnQueueGate(thread({ archivedAt: "2026-01-01T00:00:03.000Z" }), queueItem())
        .kind,
    ).toBe("pause");
    expect(
      resolveNextTurnQueueGate(thread(), queueItem({ status: "paused", lastError: "Manual" })),
    ).toEqual({ kind: "pause", reason: "Manual" });
  });
});

describe("drainNextTurnQueue", () => {
  it("dispatches with the persisted start time instead of the enqueue time", async () => {
    const item = queueItem();
    const dispatchStartedAt = "2026-01-01T00:00:30.000Z";
    const dispatched: ThreadTurnStartCommand[] = [];
    let preparedAt: string | null = null;
    let completed = false;
    const store = {
      listThreadIds: Effect.succeed([threadId]),
      list: () => Effect.succeed([item]),
      prepareForDispatch: (_itemId: CommandId, timestamp: string) => {
        preparedAt = timestamp;
        return Effect.succeed({ ...item.command, createdAt: timestamp });
      },
      complete: () =>
        Effect.sync(() => {
          completed = true;
        }),
    } as unknown as NextTurnQueueStore;

    await Effect.runPromise(
      drainNextTurnQueue({
        store,
        getSnapshot: () =>
          Effect.succeed({ threads: [thread()] } as unknown as OrchestrationReadModel),
        worktreeExists: () => Effect.succeed(true),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }),
        onUpdated: () => Effect.void,
        now: () => dispatchStartedAt,
      }),
    );

    expect(preparedAt).toBe(dispatchStartedAt);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.createdAt).toBe(dispatchStartedAt);
    expect(completed).toBe(true);
  });
});
