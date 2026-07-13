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
  ChatAttachment,
  ClientThreadTurnStartCommand,
  ModelSelection,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  ThreadTurnStartCommand,
} from "./orchestration";

/**
 * Queue rows remain `dispatching` until the provider handoff has been durably
 * acknowledged. Mutations are intentionally restricted to non-dispatching rows.
 */
export const NextTurnQueueItemStatus = Schema.Literals(["queued", "dispatching", "paused"]);
export type NextTurnQueueItemStatus = typeof NextTurnQueueItemStatus.Type;

export const NextTurnQueueFailurePolicy = Schema.Literals(["stop", "continue"]);
export type NextTurnQueueFailurePolicy = typeof NextTurnQueueFailurePolicy.Type;

export const NextTurnQueueBlockerCode = Schema.Literals([
  "manual_pause",
  "active_turn",
  "session_starting",
  "provider_handoff",
  "previous_turn_failed",
  "previous_turn_interrupted",
  "provider_error",
  "provider_busy",
  "delivery_unknown",
  "response_required",
  "thread_archived",
  "thread_missing",
  "worktree_missing",
  "malformed_command",
  "queue_paused",
]);
export type NextTurnQueueBlockerCode = typeof NextTurnQueueBlockerCode.Type;

export const NextTurnQueueBlocker = Schema.Struct({
  code: NextTurnQueueBlockerCode,
  message: Schema.String,
  resumable: Schema.Boolean,
});
export type NextTurnQueueBlocker = typeof NextTurnQueueBlocker.Type;

export const NextTurnQueueItem = Schema.Struct({
  itemId: CommandId,
  threadId: ThreadId,
  position: NonNegativeInt,
  status: NextTurnQueueItemStatus,
  failurePolicy: NextTurnQueueFailurePolicy,
  revision: NonNegativeInt,
  envelopeVersion: NonNegativeInt,
  command: ThreadTurnStartCommand,
  blocker: Schema.NullOr(NextTurnQueueBlocker),
  dispatchStartedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NextTurnQueueItem = typeof NextTurnQueueItem.Type;

export const NextTurnQueueSnapshot = Schema.Struct({
  threadId: ThreadId,
  version: NonNegativeInt,
  items: Schema.Array(NextTurnQueueItem),
  blocker: Schema.NullOr(NextTurnQueueBlocker),
});
export type NextTurnQueueSnapshot = typeof NextTurnQueueSnapshot.Type;

export const NextTurnQueueListInput = Schema.Struct({ threadId: ThreadId });
export type NextTurnQueueListInput = typeof NextTurnQueueListInput.Type;

export const NextTurnQueueEnqueueInput = Schema.Struct({
  itemId: CommandId,
  command: ClientThreadTurnStartCommand,
});
export type NextTurnQueueEnqueueInput = typeof NextTurnQueueEnqueueInput.Type;

export const NextTurnSubmitActiveTurnAction = Schema.Literals(["queue", "steer"]);
export type NextTurnSubmitActiveTurnAction = typeof NextTurnSubmitActiveTurnAction.Type;

export const NextTurnSubmitInput = Schema.Struct({
  itemId: CommandId,
  command: ClientThreadTurnStartCommand,
  activeTurnAction: NextTurnSubmitActiveTurnAction,
});
export type NextTurnSubmitInput = typeof NextTurnSubmitInput.Type;

export const NextTurnSubmitResult = Schema.Union([
  Schema.Struct({
    disposition: Schema.Literal("started"),
    sequence: NonNegativeInt,
  }),
  Schema.Struct({
    disposition: Schema.Literal("queued"),
    snapshot: NextTurnQueueSnapshot,
  }),
  Schema.Struct({
    disposition: Schema.Literal("steered"),
  }),
]);
export type NextTurnSubmitResult = typeof NextTurnSubmitResult.Type;

export const NextTurnQueueUpdateInput = Schema.Struct({
  itemId: CommandId,
  threadId: ThreadId,
  expectedVersion: NonNegativeInt,
  expectedRevision: NonNegativeInt,
  text: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  provider: Schema.optional(Schema.NullOr(ProviderKind)),
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  modelOptions: Schema.optional(Schema.NullOr(ProviderModelOptions)),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  failurePolicy: Schema.optional(NextTurnQueueFailurePolicy),
});
export type NextTurnQueueUpdateInput = typeof NextTurnQueueUpdateInput.Type;

export const NextTurnQueueCancelInput = Schema.Struct({
  itemId: CommandId,
  threadId: ThreadId,
  expectedVersion: NonNegativeInt,
});
export type NextTurnQueueCancelInput = typeof NextTurnQueueCancelInput.Type;

export const NextTurnQueueCancelOutcome = Schema.Literals(["cancelled", "too_late"]);
export type NextTurnQueueCancelOutcome = typeof NextTurnQueueCancelOutcome.Type;

export const NextTurnQueueCancelResult = Schema.Struct({
  outcome: NextTurnQueueCancelOutcome,
  snapshot: NextTurnQueueSnapshot,
});
export type NextTurnQueueCancelResult = typeof NextTurnQueueCancelResult.Type;

export const NextTurnQueueReorderInput = Schema.Struct({
  threadId: ThreadId,
  orderedItemIds: Schema.Array(CommandId),
  expectedVersion: NonNegativeInt,
});
export type NextTurnQueueReorderInput = typeof NextTurnQueueReorderInput.Type;

export const NextTurnQueueResumeInput = Schema.Struct({
  itemId: CommandId,
  threadId: ThreadId,
  expectedVersion: NonNegativeInt,
  failurePolicy: Schema.optional(NextTurnQueueFailurePolicy),
});
export type NextTurnQueueResumeInput = typeof NextTurnQueueResumeInput.Type;

const NextTurnQueueVersionedThreadInput = Schema.Struct({
  threadId: ThreadId,
  expectedVersion: NonNegativeInt,
});

export const NextTurnQueuePauseQueueInput = NextTurnQueueVersionedThreadInput;
export type NextTurnQueuePauseQueueInput = typeof NextTurnQueuePauseQueueInput.Type;

export const NextTurnQueueResumeQueueInput = NextTurnQueueVersionedThreadInput;
export type NextTurnQueueResumeQueueInput = typeof NextTurnQueueResumeQueueInput.Type;

export const NextTurnQueueClearInput = NextTurnQueueVersionedThreadInput;
export type NextTurnQueueClearInput = typeof NextTurnQueueClearInput.Type;

export const NextTurnQueueClearResult = Schema.Struct({
  snapshot: NextTurnQueueSnapshot,
  skippedDispatching: Schema.Boolean,
});
export type NextTurnQueueClearResult = typeof NextTurnQueueClearResult.Type;
