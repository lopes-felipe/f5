import {
  CommandId,
  EventId,
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
import { OrchestrationCommandConflictError } from "./orchestration/Errors.ts";

const threadId = ThreadId.makeUnsafe("queue-gate-thread");

function queueItem(overrides: Partial<NextTurnQueueItem> = {}): NextTurnQueueItem {
  return {
    itemId: CommandId.makeUnsafe("queue-gate-item"),
    threadId,
    position: 0,
    status: "queued",
    failurePolicy: "stop",
    revision: 0,
    envelopeVersion: 1,
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
    blocker: null,
    dispatchStartedAt: null,
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
      blocker: {
        code: "active_turn",
        message: "Waiting for the active turn to finish.",
        resumable: false,
      },
    });
  });

  it("does not treat an idle running provider process as an active turn", () => {
    expect(
      resolveNextTurnQueueGate(
        thread({
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: null,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        }),
        queueItem(),
      ).kind,
    ).toBe("ready");
  });

  it("blocks after errors unless continue is explicit", () => {
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
    expect(resolveNextTurnQueueGate(failed, queueItem()).kind).toBe("blocked");
    expect(resolveNextTurnQueueGate(failed, queueItem({ failurePolicy: "continue" })).kind).toBe(
      "ready",
    );
  });

  it("derives missing, archived, response-required, and explicit blockers", () => {
    expect(resolveNextTurnQueueGate(undefined, queueItem()).blocker?.code).toBe("thread_missing");
    expect(
      resolveNextTurnQueueGate(thread({ archivedAt: "2026-01-01T00:00:03.000Z" }), queueItem())
        .blocker?.code,
    ).toBe("thread_archived");
    expect(
      resolveNextTurnQueueGate(
        thread({
          activities: [
            {
              id: EventId.makeUnsafe("approval-event"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval requested",
              payload: { requestId: "approval-1", requestKind: "command" },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
          ],
        }),
        queueItem(),
      ).blocker?.code,
    ).toBe("response_required");
    expect(
      resolveNextTurnQueueGate(
        thread(),
        queueItem({
          status: "paused",
          blocker: { code: "manual_pause", message: "Manual", resumable: true },
        }),
      ),
    ).toEqual({
      kind: "blocked",
      blocker: { code: "manual_pause", message: "Manual", resumable: true },
    });
  });

  it("blocks unrelated items for a proposed plan but allows its implementation or refinement", () => {
    const planThread = thread({
      proposedPlans: [
        {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-plan"),
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    const original = queueItem();
    const implementation = queueItem({
      command: {
        ...original.command,
        sourceProposedPlan: { threadId, planId: "plan-1" },
      },
    });
    const refinement = queueItem({
      command: { ...original.command, interactionMode: "plan" },
    });

    expect(resolveNextTurnQueueGate(planThread, original).blocker?.code).toBe("response_required");
    expect(resolveNextTurnQueueGate(planThread, implementation).kind).toBe("ready");
    expect(resolveNextTurnQueueGate(planThread, refinement).kind).toBe("ready");
  });
});

describe("drainNextTurnQueue", () => {
  it("claims and dispatches without deleting before provider acceptance", async () => {
    const item = queueItem();
    const dispatchStartedAt = "2026-01-01T00:00:30.000Z";
    const dispatched: ThreadTurnStartCommand[] = [];
    let claimedAt: string | null = null;
    let completed = false;
    const store = {
      listThreadIds: Effect.succeed([threadId]),
      getSnapshot: () => Effect.succeed({ threadId, version: 1, items: [item] }),
      claimHead: (_threadId: ThreadId, timestamp: string) => {
        claimedAt = timestamp;
        return Effect.succeed({
          ...item,
          status: "dispatching" as const,
          dispatchStartedAt: timestamp,
          command: { ...item.command, createdAt: timestamp },
        });
      },
      complete: () =>
        Effect.sync(() => {
          completed = true;
          return { completedItem: item, snapshot: null };
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
        getReceipt: () => Effect.succeed(null),
        onUpdated: () => Effect.void,
        now: () => dispatchStartedAt,
      }),
    );

    expect(claimedAt).toBe(dispatchStartedAt);
    expect(dispatched[0]?.createdAt).toBe(dispatchStartedAt);
    expect(completed).toBe(false);
  });

  it("completes a dispatching item only after a durable accepted receipt", async () => {
    const item = queueItem({
      status: "dispatching",
      dispatchStartedAt: "2026-01-01T00:00:30.000Z",
    });
    let completed = false;
    const store = {
      listThreadIds: Effect.succeed([threadId]),
      getSnapshot: () => Effect.succeed({ threadId, version: 2, items: [item] }),
      complete: () =>
        Effect.sync(() => {
          completed = true;
          return { completedItem: item, snapshot: null };
        }),
    } as unknown as NextTurnQueueStore;

    await Effect.runPromise(
      drainNextTurnQueue({
        store,
        getSnapshot: () =>
          Effect.succeed({ threads: [thread()] } as unknown as OrchestrationReadModel),
        worktreeExists: () => Effect.succeed(true),
        dispatch: () => Effect.void,
        getReceipt: () =>
          Effect.succeed({
            commandId: item.command.commandId,
            eventId: EventId.makeUnsafe("provider-intent-event"),
            threadId,
            status: "accepted" as const,
            ownerId: "test",
            error: null,
            attemptedAt: "2026-01-01T00:00:30.000Z",
            acceptedAt: "2026-01-01T00:00:31.000Z",
            updatedAt: "2026-01-01T00:00:31.000Z",
          }),
        onUpdated: () => Effect.void,
      }),
    );

    expect(completed).toBe(true);
  });

  it("replays a persisted provider intent before redispatching orchestration", async () => {
    const item = queueItem({
      status: "dispatching",
      dispatchStartedAt: "2026-01-01T00:00:30.000Z",
    });
    let replayedCommandId: CommandId | null = null;
    let orchestrationDispatches = 0;
    const store = {
      listThreadIds: Effect.succeed([threadId]),
      getSnapshot: () => Effect.succeed({ threadId, version: 2, items: [item] }),
    } as unknown as NextTurnQueueStore;

    await Effect.runPromise(
      drainNextTurnQueue({
        store,
        getSnapshot: () =>
          Effect.succeed({ threads: [thread()] } as unknown as OrchestrationReadModel),
        worktreeExists: () => Effect.succeed(true),
        dispatch: () =>
          Effect.sync(() => {
            orchestrationDispatches += 1;
          }),
        getReceipt: () => Effect.succeed(null),
        retryTurnStart: (commandId) =>
          Effect.sync(() => {
            replayedCommandId = commandId;
            return true;
          }),
        onUpdated: () => Effect.void,
      }),
    );

    expect(replayedCommandId).toBe(item.command.commandId);
    expect(orchestrationDispatches).toBe(0);
  });

  it("pauses a recovered dispatch when orchestration redispatch fails", async () => {
    const item = queueItem({
      status: "dispatching",
      dispatchStartedAt: "2026-01-01T00:00:30.000Z",
    });
    let paused = false;
    const store = {
      listThreadIds: Effect.succeed([threadId]),
      getSnapshot: () => Effect.succeed({ threadId, version: 2, items: [item] }),
      pause: () =>
        Effect.sync(() => {
          paused = true;
          return { threadId, version: 3, items: [item] };
        }),
    } as unknown as NextTurnQueueStore;

    await Effect.runPromise(
      drainNextTurnQueue({
        store,
        getSnapshot: () =>
          Effect.succeed({ threads: [thread()] } as unknown as OrchestrationReadModel),
        worktreeExists: () => Effect.succeed(true),
        dispatch: () => Effect.fail(new Error("provider adapter failed")),
        getReceipt: () => Effect.succeed(null),
        retryTurnStart: () => Effect.succeed(false),
        onUpdated: () => Effect.void,
      }),
    );

    expect(paused).toBe(true);
  });

  it("releases a claim when another turn wins the dispatch race", async () => {
    const item = queueItem();
    let released = false;
    let paused = false;
    const store = {
      listThreadIds: Effect.succeed([threadId]),
      getSnapshot: () => Effect.succeed({ threadId, version: 1, items: [item] }),
      claimHead: () =>
        Effect.succeed({
          ...item,
          status: "dispatching" as const,
          dispatchStartedAt: "2026-01-01T00:00:30.000Z",
        }),
      releaseClaim: () =>
        Effect.sync(() => {
          released = true;
          return { threadId, version: 2, items: [item] };
        }),
      pause: () =>
        Effect.sync(() => {
          paused = true;
          return { threadId, version: 2, items: [item] };
        }),
    } as unknown as NextTurnQueueStore;

    await Effect.runPromise(
      drainNextTurnQueue({
        store,
        getSnapshot: () =>
          Effect.succeed({ threads: [thread()] } as unknown as OrchestrationReadModel),
        worktreeExists: () => Effect.succeed(true),
        dispatch: () =>
          Effect.fail(
            new OrchestrationCommandConflictError({
              code: "thread_busy",
              commandType: "thread.turn.start",
              detail: "The competing request has not settled yet.",
            }),
          ),
        getReceipt: () => Effect.succeed(null),
        onUpdated: () => Effect.void,
      }),
    );

    expect(released).toBe(true);
    expect(paused).toBe(false);
  });
});
