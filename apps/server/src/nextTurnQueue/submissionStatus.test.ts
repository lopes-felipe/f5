import { CommandId, MessageId, TurnId, type NextTurnQueueSnapshot } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { emptyQueue } from "../agentBridge/testing/fakeHost.ts";
import { reviewThread, REVIEW_NOW } from "../upstreamPorts/testing/reviewFixtures.ts";
import {
  bindSubmissionTurnIds,
  resolveTurnSubmissionStatus,
  type TurnSubmissionStatusDeps,
} from "./submissionStatus.ts";

describe("resolveTurnSubmissionStatus", () => {
  const thread = reviewThread();
  const turnId = TurnId.makeUnsafe("revision-turn");
  const messageId = MessageId.makeUnsafe("revision-message");
  const details = {
    threadId: thread.id,
    messages: [
      {
        id: messageId,
        role: "user" as const,
        text: "Fix",
        turnId: null,
        streaming: false,
        createdAt: REVIEW_NOW,
        updatedAt: REVIEW_NOW,
      },
    ],
    checkpoints: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    tasksTracking: null,
    sessionNotes: null,
    threadReferences: [],
    detailSequence: 0,
  };
  function deps(
    overrides: Partial<TurnSubmissionStatusDeps<Error>> = {},
  ): TurnSubmissionStatusDeps<Error> {
    return {
      getQueueSnapshot: () => Effect.succeed(emptyQueue(thread.id)),
      getSubmission: () =>
        Effect.succeed({
          submissionId: CommandId.makeUnsafe("revision"),
          threadId: thread.id,
          requestHash: "hash",
          itemId: null,
          messageId,
          disposition: "started",
          resultSequence: 1,
          reasonCode: null,
          createdAt: REVIEW_NOW,
          settledAt: REVIEW_NOW,
        }),
      getThreadDetails: () =>
        Effect.succeed(bindSubmissionTurnIds(details, [{ pendingMessageId: messageId, turnId }])),
      getTurnState: () => Effect.succeed("completed"),
      ...overrides,
    };
  }
  it("resolves a normal null-turnId message through the accepted projected turn, despite a later user turn", async () => {
    expect(details.messages[0]!.turnId).toBeNull();
    expect(
      await Effect.runPromise(
        resolveTurnSubmissionStatus(deps(), { thread, submissionId: "revision" }),
      ),
    ).toEqual({ status: "completed", turnId });
  });
  it.each([
    ["completed", "completed"],
    ["interrupted", "interrupted"],
    ["error", "failed"],
    ["running", "running"],
    ["pending", "running"],
  ] as const)("uses the specific turn's %s state", async (state, status) => {
    expect(
      await Effect.runPromise(
        resolveTurnSubmissionStatus(
          deps({
            getTurnState: (input) => {
              expect(input.turnId).toBe(turnId);
              return Effect.succeed(state);
            },
          }),
          { thread, submissionId: "revision", knownTurnId: turnId },
        ),
      ),
    ).toMatchObject({ status, turnId });
  });
  it("falls back to the same latest turn when its projection is temporarily missing", async () => {
    expect(await Effect.runPromise(resolveTurnSubmissionStatus(
      deps({ getTurnState: () => Effect.succeed(null) }),
      { thread: { ...thread, latestTurn: { ...thread.latestTurn!, turnId, state: "completed" } },
        submissionId: "revision", knownTurnId: turnId },
    ))).toEqual({ status: "completed", turnId });
  });
  it.each(["canceled", "cleared", "rejected"] as const)(
    "maps %s to rejected",
    async (disposition) => {
      const original = deps();
      const result = await Effect.runPromise(
        resolveTurnSubmissionStatus(
          deps({
            getSubmission: (id) =>
              original
                .getSubmission(id)
                .pipe(Effect.map((record) => ({ ...record!, disposition }))),
          }),
          { thread, submissionId: "revision" },
        ),
      );
      expect(result).toEqual({ status: "rejected", reason: disposition });
    },
  );
  it.each([
    [{ reasonCode: "worktree_setup" }, "preparing-worktree"],
    [{ blockedKind: "paused", reasonDetail: "Paused" }, "blocked"],
    [{ blockedKind: "error" }, "blocked"],
    [{}, "queued"],
  ] as const)("resolves queued state", async (patch, status) => {
    const queue = {
      ...emptyQueue(thread.id),
      ...patch,
      items: [{ submissionId: "revision", status: "pending" }],
    } as unknown as NextTurnQueueSnapshot;
    expect(
      await Effect.runPromise(
        resolveTurnSubmissionStatus(deps({ getQueueSnapshot: () => Effect.succeed(queue) }), {
          thread,
          submissionId: "revision",
        }),
      ),
    ).toMatchObject({ status });
  });
  it("caches the turn binding and recognizes input and approval waits only on that turn", async () => {
    const running = reviewThread({
      latestTurn: { ...thread.latestTurn!, turnId, state: "running" },
      activities: [
        {
          id: "approval",
          kind: "approval.requested",
          payload: { requestId: "r1" },
          createdAt: REVIEW_NOW,
          sequence: 1,
        },
      ] as never,
    });
    expect(
      await Effect.runPromise(
        resolveTurnSubmissionStatus(
          deps({
            getThreadDetails: () => Effect.die("must use cached binding"),
            getTurnState: () => Effect.succeed("running"),
          }),
          { thread: running, submissionId: "revision", knownTurnId: turnId },
        ),
      ),
    ).toEqual({ status: "awaiting-approval", turnId });
    expect(
      await Effect.runPromise(
        resolveTurnSubmissionStatus(
          deps({
            getTurnState: () => Effect.succeed("running"),
          }),
          { thread: { ...running, pendingUserInputs: [{}] as never }, submissionId: "revision" },
        ),
      ),
    ).toEqual({ status: "awaiting-input", turnId });
  });
});
