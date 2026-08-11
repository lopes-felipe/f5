import { Schema } from "effect";

const QueueErrorFields = {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
};

export class NextTurnQueueItemNotFoundError extends Schema.TaggedErrorClass<NextTurnQueueItemNotFoundError>()(
  "NextTurnQueueItemNotFoundError",
  QueueErrorFields,
) {}

export class NextTurnQueueThreadNotFoundError extends Schema.TaggedErrorClass<NextTurnQueueThreadNotFoundError>()(
  "NextTurnQueueThreadNotFoundError",
  QueueErrorFields,
) {}

export class NextTurnQueueItemDispatchingError extends Schema.TaggedErrorClass<NextTurnQueueItemDispatchingError>()(
  "NextTurnQueueItemDispatchingError",
  QueueErrorFields,
) {}

export class NextTurnQueueItemAlreadyRanError extends Schema.TaggedErrorClass<NextTurnQueueItemAlreadyRanError>()(
  "NextTurnQueueItemAlreadyRanError",
  QueueErrorFields,
) {}

export class NextTurnQueueConflictError extends Schema.TaggedErrorClass<NextTurnQueueConflictError>()(
  "NextTurnQueueConflictError",
  QueueErrorFields,
) {}

export class NextTurnQueueLimitExceededError extends Schema.TaggedErrorClass<NextTurnQueueLimitExceededError>()(
  "NextTurnQueueLimitExceededError",
  QueueErrorFields,
) {}

export class NextTurnQueueReorderMismatchError extends Schema.TaggedErrorClass<NextTurnQueueReorderMismatchError>()(
  "NextTurnQueueReorderMismatchError",
  QueueErrorFields,
) {}

export class NextTurnQueueBootstrapNotAllowedError extends Schema.TaggedErrorClass<NextTurnQueueBootstrapNotAllowedError>()(
  "NextTurnQueueBootstrapNotAllowedError",
  QueueErrorFields,
) {}

export class NextTurnQueueIdempotencyConflictError extends Schema.TaggedErrorClass<NextTurnQueueIdempotencyConflictError>()(
  "NextTurnQueueIdempotencyConflictError",
  QueueErrorFields,
) {}

export class NextTurnQueueStorageError extends Schema.TaggedErrorClass<NextTurnQueueStorageError>()(
  "NextTurnQueueStorageError",
  QueueErrorFields,
) {}

export class NextTurnQueueClaimLostError extends Schema.TaggedErrorClass<NextTurnQueueClaimLostError>()(
  "NextTurnQueueClaimLostError",
  QueueErrorFields,
) {}

export type NextTurnQueueError =
  | NextTurnQueueItemNotFoundError
  | NextTurnQueueThreadNotFoundError
  | NextTurnQueueItemDispatchingError
  | NextTurnQueueItemAlreadyRanError
  | NextTurnQueueConflictError
  | NextTurnQueueLimitExceededError
  | NextTurnQueueReorderMismatchError
  | NextTurnQueueBootstrapNotAllowedError
  | NextTurnQueueIdempotencyConflictError
  | NextTurnQueueStorageError
  | NextTurnQueueClaimLostError;

export function toNextTurnQueueStorageError(
  cause: unknown,
  message = "Could not read the queued turns.",
): NextTurnQueueStorageError {
  return new NextTurnQueueStorageError({ message, cause });
}
