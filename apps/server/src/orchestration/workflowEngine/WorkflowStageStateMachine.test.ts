import { CommandId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  acceptedDeliveryMatchesCurrentTurn,
  canConsumeCompletedStageTurn,
  hasNewerActiveStageTurn,
  isStageAlreadyCompletedWith,
  transitionStageCompleted,
  transitionStageError,
  transitionStagePendingStart,
  transitionStageRunning,
} from "./WorkflowStageStateMachine.ts";

const makeThread = (overrides?: {
  readonly turnId?: string;
  readonly state?: "running" | "completed";
  readonly requestedAt?: string;
  readonly completedAt?: string;
  readonly sessionStatus?: "running" | "ready";
}) =>
  ({
    id: ThreadId.make("thread-1"),
    session: {
      status: overrides?.sessionStatus ?? "ready",
      activeTurnId:
        overrides?.sessionStatus === "running" ? TurnId.make(overrides?.turnId ?? "turn-1") : null,
    },
    latestTurn: {
      turnId: TurnId.make(overrides?.turnId ?? "turn-1"),
      state: overrides?.state ?? "completed",
      requestedAt: overrides?.requestedAt ?? "2026-01-01T00:00:01.000Z",
      completedAt: overrides?.completedAt ?? "2026-01-01T00:00:05.000Z",
      assistantMessageId: MessageId.make("msg-1"),
    },
    messages: [
      {
        id: MessageId.make("msg-1"),
        role: "assistant",
        turnId: TurnId.make(overrides?.turnId ?? "turn-1"),
        text: "Final report",
        streaming: false,
      },
    ],
  }) as never;

describe("WorkflowStageStateMachine", () => {
  it("gates running stage completion on matching dispatched turn and allows error/unpinned recovery", () => {
    const thread = makeThread({ turnId: "turn-2", completedAt: "2026-01-01T00:00:10.000Z" });
    const runningStage = {
      status: "running",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      updatedAt: "2026-01-01T00:00:05.000Z",
    };

    expect(
      canConsumeCompletedStageTurn(runningStage, thread, {
        kind: "turn",
        turnId: TurnId.make("turn-2"),
      }),
    ).toBe(true);
    expect(
      canConsumeCompletedStageTurn(runningStage, thread, {
        kind: "turn",
        turnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);

    expect(
      canConsumeCompletedStageTurn(
        { ...runningStage, status: "error", updatedAt: "2026-01-01T00:00:08.000Z" },
        thread,
        { kind: "pending" },
      ),
    ).toBe(true);
    expect(
      canConsumeCompletedStageTurn(
        { ...runningStage, status: "completed", pinnedTurnId: null },
        thread,
        { kind: "pending" },
      ),
    ).toBe(true);
  });

  it("checks newer active turns and accepted delivery correlation", () => {
    const runningThread = makeThread({
      turnId: "turn-3",
      state: "running",
      requestedAt: "2026-01-01T00:00:12.000Z",
      sessionStatus: "running",
    });
    expect(hasNewerActiveStageTurn("2026-01-01T00:00:10.000Z", runningThread)).toBe(true);
    expect(hasNewerActiveStageTurn("2026-01-01T00:00:15.000Z", runningThread)).toBe(false);

    expect(
      acceptedDeliveryMatchesCurrentTurn(
        {
          state: "accepted",
          providerTurnId: TurnId.make("turn-3"),
          preSendTurnIds: [],
        } as never,
        runningThread,
      ),
    ).toBe(true);
    expect(
      acceptedDeliveryMatchesCurrentTurn(
        {
          state: "accepted",
          providerTurnId: TurnId.make("turn-4"),
          preSendTurnIds: [TurnId.make("turn-3")],
        } as never,
        runningThread,
      ),
    ).toBe(true);
  });

  it("performs immutable stage state transitions", () => {
    const base = {
      threadId: null as ThreadId | null,
      status: "not_started",
      pinnedTurnId: null as string | null,
      pinnedAssistantMessageId: null as string | null,
      error: "old" as string | null,
      dispatchCommandId: null as CommandId | null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const pending = transitionStagePendingStart(
      base,
      ThreadId.make("t1"),
      "2026-01-01T00:00:01.000Z",
    );
    expect(pending.status).toBe("pending_start");
    expect(pending.threadId).toBe("t1");
    expect(pending.error).toBeNull();

    const running = transitionStageRunning(
      pending,
      "2026-01-01T00:00:02.000Z",
      CommandId.makeUnsafe("cmd-1"),
    );
    expect(running.status).toBe("running");
    expect(running.dispatchCommandId).toBe("cmd-1");

    const completed = transitionStageCompleted(running, {
      turnId: "turn-1",
      assistantMessageId: "msg-1",
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
    expect(isStageAlreadyCompletedWith(completed, "turn-1", "msg-1")).toBe(true);

    const errored = transitionStageError(completed, "failed", "2026-01-01T00:00:04.000Z");
    expect(errored.status).toBe("error");
    expect(errored.error).toBe("failed");
  });
});
