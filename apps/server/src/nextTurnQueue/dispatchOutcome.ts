import { MAX_DISPATCH_ATTEMPTS } from "./constants.ts";

export type NextTurnDispatchOutcome =
  | {
      readonly kind: "retry";
      readonly delayMs: number;
      readonly clearDispatchStartedAt: boolean;
      readonly consumeAttempt: boolean;
      readonly errorCode: string;
      readonly errorDetail: string;
    }
  | {
      readonly kind: "failed";
      readonly errorCode: string;
      readonly errorDetail: string;
    };

function taggedError(error: unknown): { readonly tag: string; readonly message: string } {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    const tag = typeof error._tag === "string" ? error._tag : "UnknownDispatchError";
    const message = error instanceof Error ? error.message : "The turn could not be sent.";
    return { tag, message };
  }
  return {
    tag: "UnknownDispatchError",
    message: error instanceof Error ? error.message : "The turn could not be sent.",
  };
}

export function nextTurnDispatchBackoffMs(
  postClaimAttempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, postClaimAttempt - 1));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(base * jitter);
}

export function classifyNextTurnDispatchFailure(input: {
  readonly error: unknown;
  readonly postClaimAttempt: number;
  readonly random?: (() => number) | undefined;
}): NextTurnDispatchOutcome {
  const { tag, message } = taggedError(input.error);
  if (tag === "ThreadTurnAlreadyActiveError") {
    return {
      kind: "retry",
      delayMs: 250,
      clearDispatchStartedAt: true,
      consumeAttempt: false,
      errorCode: tag,
      errorDetail: message,
    };
  }
  if (tag === "OrchestrationCommandPreviouslyRejectedError") {
    return { kind: "failed", errorCode: tag, errorDetail: message };
  }
  if (tag === "OrchestrationCommandInvariantError") {
    return { kind: "failed", errorCode: tag, errorDetail: message };
  }

  const definitelyUncommitted = tag === "RouteRequestError";
  if (input.postClaimAttempt >= MAX_DISPATCH_ATTEMPTS && !definitelyUncommitted) {
    return {
      kind: "failed",
      errorCode: tag,
      errorDetail: "The turn could not be sent after several attempts. Retry it to continue.",
    };
  }
  return {
    kind: "retry",
    delayMs: nextTurnDispatchBackoffMs(input.postClaimAttempt, input.random),
    clearDispatchStartedAt: definitelyUncommitted,
    consumeAttempt: !definitelyUncommitted,
    errorCode: tag,
    errorDetail: message,
  };
}
