import {
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
} from "@t3tools/contracts";
import { Data } from "effect";
export const TURN_SUBMISSION_FAILURES = [
  "idempotency_conflict",
  "project_unavailable",
  "provider_unavailable",
  "worktree_unavailable",
  "rejected",
  "delivery_unknown",
] as const;
export type TurnSubmissionFailure = (typeof TURN_SUBMISSION_FAILURES)[number];
export class TurnSubmissionError extends Data.TaggedError("TurnSubmissionError")<{
  readonly kind: TurnSubmissionFailure;
  readonly message: string;
  readonly code?: string | undefined;
}> {}
/** Transport-independent classification uses structured codes, never provider error text. */
export function toTurnSubmissionError(error: {
  readonly message: string;
  readonly code?: string | undefined;
}): TurnSubmissionError {
  const kind: TurnSubmissionFailure =
    error.code === BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE ||
    error.code === BOOTSTRAP_THREAD_DELETED_ERROR_CODE
      ? "worktree_unavailable"
      : error.code === "NextTurnQueueIdempotencyConflictError"
        ? "idempotency_conflict"
        : error.code === "NextTurnQueueThreadNotFoundError"
          ? "project_unavailable"
          : error.code === "ProviderUnavailableError"
            ? "provider_unavailable"
            : error.code === "NextTurnQueueBootstrapNotAllowedError"
              ? "rejected"
              : "delivery_unknown";
  return new TurnSubmissionError({
    kind,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  });
}
