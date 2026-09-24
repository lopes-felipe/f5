import { describe, expect, it } from "vitest";

import { OrchestrationCommandIdConflictError } from "../orchestration/Errors.ts";

import { MAX_DISPATCH_ATTEMPTS } from "./constants.ts";
import { classifyNextTurnDispatchFailure, nextTurnDispatchBackoffMs } from "./dispatchOutcome.ts";

describe("next-turn dispatch outcomes", () => {
  it("retries busy and runtime-startup races without consuming the budget", () => {
    expect(
      classifyNextTurnDispatchFailure({
        error: { _tag: "ThreadTurnAlreadyActiveError" },
        postClaimAttempt: 6,
      }),
    ).toMatchObject({ kind: "retry", delayMs: 250, consumeAttempt: false });
    expect(
      classifyNextTurnDispatchFailure({
        error: { _tag: "RouteRequestError" },
        postClaimAttempt: 6,
        random: () => 0.5,
      }),
    ).toMatchObject({
      kind: "retry",
      clearDispatchStartedAt: true,
      consumeAttempt: false,
    });
  });

  it("fails poisoned and exhausted attempts", () => {
    expect(
      classifyNextTurnDispatchFailure({
        error: { _tag: "OrchestrationCommandPreviouslyRejectedError" },
        postClaimAttempt: 1,
      }),
    ).toMatchObject({ kind: "failed" });
    expect(
      classifyNextTurnDispatchFailure({
        error: new Error("unknown"),
        postClaimAttempt: MAX_DISPATCH_ATTEMPTS,
      }),
    ).toMatchObject({ kind: "failed" });
  });

  it("fails command conflicts immediately and preserves the diagnosis", () => {
    const error = new OrchestrationCommandIdConflictError({
      commandId: "collision",
      receiptAggregateKind: "thread",
      receiptAggregateId: "a",
      commandAggregateKind: "thread",
      commandAggregateId: "b",
    });
    for (const postClaimAttempt of [1, MAX_DISPATCH_ATTEMPTS]) {
      expect(classifyNextTurnDispatchFailure({ error, postClaimAttempt })).toEqual({
        kind: "failed",
        errorCode: error._tag,
        errorDetail: error.message,
      });
    }
  });

  it("uses post-claim exponential backoff with bounded jitter", () => {
    expect(nextTurnDispatchBackoffMs(1, () => 0)).toBe(800);
    expect(nextTurnDispatchBackoffMs(1, () => 1)).toBe(1_200);
    expect(nextTurnDispatchBackoffMs(20, () => 0.5)).toBe(60_000);
  });
});
