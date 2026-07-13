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

export const NextTurnQueueItemStatus = Schema.Literals(["queued", "paused"]);
export type NextTurnQueueItemStatus = typeof NextTurnQueueItemStatus.Type;

export const NextTurnQueueItem = Schema.Struct({
  itemId: CommandId,
  threadId: ThreadId,
  position: NonNegativeInt,
  status: NextTurnQueueItemStatus,
  allowAfterError: Schema.Boolean,
  command: ThreadTurnStartCommand,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NextTurnQueueItem = typeof NextTurnQueueItem.Type;

export const NextTurnQueueSnapshot = Schema.Struct({
  threadId: ThreadId,
  items: Schema.Array(NextTurnQueueItem),
  blockedReason: Schema.NullOr(Schema.String),
});
export type NextTurnQueueSnapshot = typeof NextTurnQueueSnapshot.Type;

export const NextTurnQueueListInput = Schema.Struct({ threadId: ThreadId });
export type NextTurnQueueListInput = typeof NextTurnQueueListInput.Type;

export const NextTurnQueueEnqueueInput = Schema.Struct({
  itemId: CommandId,
  command: ClientThreadTurnStartCommand,
});
export type NextTurnQueueEnqueueInput = typeof NextTurnQueueEnqueueInput.Type;

export const NextTurnQueueUpdateInput = Schema.Struct({
  itemId: CommandId,
  text: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  modelOptions: Schema.optional(ProviderModelOptions),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type NextTurnQueueUpdateInput = typeof NextTurnQueueUpdateInput.Type;

export const NextTurnQueueCancelInput = Schema.Struct({ itemId: CommandId });
export type NextTurnQueueCancelInput = typeof NextTurnQueueCancelInput.Type;

export const NextTurnQueueReorderInput = Schema.Struct({
  threadId: ThreadId,
  orderedItemIds: Schema.Array(CommandId),
});
export type NextTurnQueueReorderInput = typeof NextTurnQueueReorderInput.Type;

export const NextTurnQueueResumeInput = Schema.Struct({ itemId: CommandId });
export type NextTurnQueueResumeInput = typeof NextTurnQueueResumeInput.Type;
