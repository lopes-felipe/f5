import { Schema } from "effect";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderModelOptions } from "./model";
import {
  ClientThreadTurnStartCommand,
  ModelSelection,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  ThreadTurnStartCommand,
} from "./orchestration";

export const MAX_QUEUED_TURNS_PER_THREAD = 20;

export const NextTurnQueueItemStatus = Schema.Literals(["queued", "dispatching", "failed"]);
export type NextTurnQueueItemStatus = typeof NextTurnQueueItemStatus.Type;

export const NextTurnQueueBlockedKind = Schema.Literals(["waiting", "paused", "error"]);
export type NextTurnQueueBlockedKind = typeof NextTurnQueueBlockedKind.Type;

export const QueueReasonCode = Schema.Literals([
  "manual_pause",
  "active_turn",
  "turn_starting",
  "dispatch_in_flight",
  "turn_post_processing",
  "post_processing_stalled",
  "turn_failed",
  "turn_never_started",
  "turn_interrupted",
  "delivery_retrying",
  "delivery_rejected",
  "delivery_ambiguous",
  "thread_archived",
  "thread_reverted",
  "thread_compacting",
  "thread_compacted",
  "thread_deleted",
  "worktree_missing",
  "dispatch_rejected",
]);
export type QueueReasonCode = typeof QueueReasonCode.Type;

export const NextTurnQueueItem = Schema.Struct({
  itemId: CommandId,
  threadId: ThreadId,
  submissionId: CommandId,
  position: NonNegativeInt,
  status: NextTurnQueueItemStatus,
  command: ThreadTurnStartCommand,
  attemptCount: NonNegativeInt,
  notBefore: Schema.NullOr(IsoDateTime),
  dispatchStartedAt: Schema.NullOr(IsoDateTime),
  lastErrorCode: Schema.NullOr(Schema.String),
  lastErrorDetail: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NextTurnQueueItem = typeof NextTurnQueueItem.Type;

export const NextTurnQueueSnapshot = Schema.Struct({
  threadId: ThreadId,
  items: Schema.Array(NextTurnQueueItem),
  revision: NonNegativeInt,
  paused: Schema.Boolean,
  blockedKind: Schema.NullOr(NextTurnQueueBlockedKind),
  reasonCode: Schema.NullOr(QueueReasonCode),
  reasonDetail: Schema.NullOr(Schema.String),
  maxItems: NonNegativeInt,
  quarantinedCount: NonNegativeInt,
});
export type NextTurnQueueSnapshot = typeof NextTurnQueueSnapshot.Type;

export const NextTurnQueueThreadSummary = Schema.Struct({
  threadId: ThreadId,
  queuedCount: NonNegativeInt,
  dispatchingCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  paused: Schema.Boolean,
});
export type NextTurnQueueThreadSummary = typeof NextTurnQueueThreadSummary.Type;

export const NextTurnQueueSummary = Schema.Struct({
  threads: Schema.Array(NextTurnQueueThreadSummary),
});
export type NextTurnQueueSummary = typeof NextTurnQueueSummary.Type;

export const NextTurnQueueMutationResult = Schema.Struct({
  snapshot: NextTurnQueueSnapshot,
  removed: Schema.Array(NextTurnQueueItem),
});
export type NextTurnQueueMutationResult = typeof NextTurnQueueMutationResult.Type;

export const TurnSubmissionIntent = Schema.Literals(["auto", "queue-tail", "queue-head"]);
export type TurnSubmissionIntent = typeof TurnSubmissionIntent.Type;

const TurnSubmissionResultBase = {
  submissionId: CommandId,
};

export const TurnSubmissionResult = Schema.Union([
  Schema.Struct({
    ...TurnSubmissionResultBase,
    disposition: Schema.Literal("started"),
    sequence: NonNegativeInt,
  }),
  Schema.Struct({
    ...TurnSubmissionResultBase,
    disposition: Schema.Literal("queued"),
    itemId: CommandId,
    snapshot: NextTurnQueueSnapshot,
  }),
  Schema.Struct({
    ...TurnSubmissionResultBase,
    disposition: Schema.Literals(["canceled", "cleared", "rejected"]),
    reasonCode: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
]);
export type TurnSubmissionResult = typeof TurnSubmissionResult.Type;

export const NextTurnQueueListInput = Schema.Struct({ threadId: ThreadId });
export type NextTurnQueueListInput = typeof NextTurnQueueListInput.Type;

export const NextTurnQueueSubmitInput = Schema.Struct({
  submissionId: CommandId,
  command: ClientThreadTurnStartCommand,
  intent: TurnSubmissionIntent,
});
export type NextTurnQueueSubmitInput = typeof NextTurnQueueSubmitInput.Type;

export const NextTurnQueueUpdateInput = Schema.Struct({
  itemId: CommandId,
  text: Schema.optional(Schema.String),
  skillCall: Schema.optional(
    Schema.NullOr(ClientThreadTurnStartCommand.fields.message.fields.skillCall),
  ),
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  modelOptions: Schema.optional(ProviderModelOptions),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  expectedUpdatedAt: IsoDateTime,
});
export type NextTurnQueueUpdateInput = typeof NextTurnQueueUpdateInput.Type;

export const NextTurnQueueCancelInput = Schema.Struct({
  itemId: CommandId,
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type NextTurnQueueCancelInput = typeof NextTurnQueueCancelInput.Type;

export const NextTurnQueueReorderInput = Schema.Struct({
  threadId: ThreadId,
  orderedItemIds: Schema.Array(CommandId),
  expectedRevision: NonNegativeInt,
});
export type NextTurnQueueReorderInput = typeof NextTurnQueueReorderInput.Type;

export const NextTurnQueueRetryInput = Schema.Struct({
  itemId: CommandId,
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type NextTurnQueueRetryInput = typeof NextTurnQueueRetryInput.Type;

export const NextTurnQueuePromoteInput = Schema.Struct({
  itemId: CommandId,
  interruptActive: Schema.Boolean,
  expectedRevision: NonNegativeInt,
});
export type NextTurnQueuePromoteInput = typeof NextTurnQueuePromoteInput.Type;

export const NextTurnQueueSetPausedInput = Schema.Struct({
  threadId: ThreadId,
  paused: Schema.Boolean,
  expectedRevision: NonNegativeInt,
});
export type NextTurnQueueSetPausedInput = typeof NextTurnQueueSetPausedInput.Type;

export const NextTurnQueueDuplicateInput = Schema.Struct({
  itemId: CommandId,
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type NextTurnQueueDuplicateInput = typeof NextTurnQueueDuplicateInput.Type;

export const NextTurnQueueRefreshGateInput = Schema.Struct({ threadId: ThreadId });
export type NextTurnQueueRefreshGateInput = typeof NextTurnQueueRefreshGateInput.Type;

export const NextTurnQueueClearInput = Schema.Struct({
  threadId: ThreadId,
  scope: Schema.Literals(["all", "failed"]),
  expectedRevision: NonNegativeInt,
});
export type NextTurnQueueClearInput = typeof NextTurnQueueClearInput.Type;

export const NextTurnQueueRestoreInput = Schema.Struct({
  threadId: ThreadId,
  itemIds: Schema.Array(CommandId),
  expectedRevision: NonNegativeInt,
});
export type NextTurnQueueRestoreInput = typeof NextTurnQueueRestoreInput.Type;

export const NextTurnQueueSummaryInput = Schema.Struct({});
export type NextTurnQueueSummaryInput = typeof NextTurnQueueSummaryInput.Type;

export const NextTurnQueueRecheckDeliveryInput = Schema.Struct({ threadId: ThreadId });
export type NextTurnQueueRecheckDeliveryInput = typeof NextTurnQueueRecheckDeliveryInput.Type;

export const NextTurnQueueRetryDeliveryInput = Schema.Struct({
  threadId: ThreadId,
  allowPossibleDuplicate: Schema.Boolean,
});
export type NextTurnQueueRetryDeliveryInput = typeof NextTurnQueueRetryDeliveryInput.Type;

export const NextTurnQueueDiscardDeliveryInput = Schema.Struct({ threadId: ThreadId });
export type NextTurnQueueDiscardDeliveryInput = typeof NextTurnQueueDiscardDeliveryInput.Type;
