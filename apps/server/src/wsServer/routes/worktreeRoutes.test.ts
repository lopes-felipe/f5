import { ThreadId, WS_METHODS } from "@t3tools/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import { worktreeRoutes } from "./worktreeRoutes.ts";

const fakeWs = {} as WebSocket;

describe("worktreeRoutes", () => {
  it("delegates worktreeSetupCancel, Retry, and WorkLocally and preserves error code", async () => {
    const threadId = ThreadId.make("thread-1");
    const snapshot = { generation: 2, sequence: 5 } as never;
    const cancel = vi.fn(() => Effect.succeed(snapshot));
    const retry = vi.fn(() => Effect.succeed(null));
    const workLocally = vi.fn(() =>
      Effect.fail({ message: "stale operation", code: "OPERATION_STALE" } as never),
    );
    const ordering = vi.fn(() => Effect.succeed({ generation: 3, sequence: 9 }));
    const publishNextTurnQueueSnapshot = vi.fn(() => Effect.void);

    const routes = worktreeRoutes({
      runtime: Effect.succeed({
        workspaceTransition: {} as never,
        worktreeManager: {} as never,
        worktreeSetup: {
          get: () => Effect.succeed(null),
          ordering,
          cancel,
          retry,
          workLocally,
        } as never,
      }),
      publishNextTurnQueueSnapshot,
    });

    const cancelResult = await Effect.runPromise(
      routes[WS_METHODS.worktreeSetupCancel](
        {
          _tag: WS_METHODS.worktreeSetupCancel,
          threadId,
          expectedOperationId: "op-1",
        },
        fakeWs,
      ),
    );
    expect(cancel).toHaveBeenCalledWith(threadId, "op-1");
    expect(cancelResult).toEqual({ snapshot, generation: 2, sequence: 5 });
    expect(publishNextTurnQueueSnapshot).toHaveBeenCalledWith(threadId);

    const retryResult = await Effect.runPromise(
      routes[WS_METHODS.worktreeSetupRetry](
        {
          _tag: WS_METHODS.worktreeSetupRetry,
          threadId,
          expectedOperationId: "op-2",
        },
        fakeWs,
      ),
    );
    expect(retry).toHaveBeenCalledWith(threadId, "op-2");
    expect(ordering).toHaveBeenCalledWith(threadId);
    expect(retryResult).toEqual({ snapshot: null, generation: 3, sequence: 9 });

    const failedExit = await Effect.runPromiseExit(
      routes[WS_METHODS.worktreeSetupWorkLocally](
        {
          _tag: WS_METHODS.worktreeSetupWorkLocally,
          threadId,
          expectedOperationId: "op-3",
        },
        fakeWs,
      ),
    );
    expect(Exit.isFailure(failedExit)).toBe(true);
    if (Exit.isFailure(failedExit)) {
      const error = Cause.squash(failedExit.cause);
      expect(error).toBeInstanceOf(RouteRequestError);
      expect((error as RouteRequestError).message).toBe("stale operation");
      expect((error as RouteRequestError).code).toBe("OPERATION_STALE");
    }
  });
});
