import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const NativeOperationState = Schema.Literals([
  "requested",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);
export type NativeOperationState = typeof NativeOperationState.Type;
export const NativeReviewTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("uncommittedChanges") }),
  Schema.Struct({ type: Schema.Literal("baseBranch"), branch: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("commit"), sha: TrimmedNonEmptyString }),
]);
export const NativeOperationCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("compact") }),
  Schema.Struct({ kind: Schema.Literal("review"), target: NativeReviewTarget }),
  Schema.Struct({
    kind: Schema.Literal("stopTask"),
    taskId: TrimmedNonEmptyString,
    runId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("revertFiles"), userMessageId: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("fork"),
    targetThreadId: ThreadId,
    cwd: TrimmedNonEmptyString,
    beforeTurnId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("goalSet"),
    objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
    tokenBudget: PositiveInt.check(Schema.isLessThanOrEqualTo(10000000)),
  }),
  Schema.Struct({ kind: Schema.Literal("goalPause") }),
  Schema.Struct({ kind: Schema.Literal("goalClear") }),
]);
export type NativeOperationCommand = typeof NativeOperationCommand.Type;
export const NativeOperationInput = Schema.Struct({
  threadId: ThreadId,
  operationId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  generation: NonNegativeInt,
  command: NativeOperationCommand,
});
export type NativeOperationInput = typeof NativeOperationInput.Type;
export const NativeOperationRecord = Schema.Struct({
  ...NativeOperationInput.fields,
  state: NativeOperationState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  applicationRequired: Schema.optional(Schema.Boolean),
  applicationApplied: Schema.optional(Schema.Boolean),
  receipt: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  staleGeneration: Schema.optional(Schema.Boolean),
});
export type NativeOperationRecord = typeof NativeOperationRecord.Type;
export const NativeOperationListInput = Schema.Struct({ threadId: ThreadId });
export const NativeOperationInspectInput = Schema.Struct({
  threadId: ThreadId,
  generation: NonNegativeInt,
  kind: Schema.Literals(["task", "filePreview", "goal", "attachments"]),
  nativeId: Schema.optional(TrimmedNonEmptyString),
  runId: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  limit: Schema.optional(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type NativeOperationInspectInput = typeof NativeOperationInspectInput.Type;
export const NativeFileRewindPreview = Schema.Struct({
  canRewind: Schema.Boolean,
  error: Schema.optional(Schema.String),
  filesChanged: Schema.optional(Schema.Array(Schema.String)),
  insertions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  skippedLinks: Schema.optional(NonNegativeInt),
});
export type NativeFileRewindPreview = typeof NativeFileRewindPreview.Type;
export const NATIVE_OPERATION_WS_METHODS = {
  fork: "nativeOperation.fork",
  execute: "nativeOperation.execute",
  list: "nativeOperation.list",
  inspect: "nativeOperation.inspect",
} as const;

export const NativeForkInput = Schema.Struct({
  threadId: ThreadId,
  operationId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  generation: NonNegativeInt,
  beforeTurnId: Schema.optional(TrimmedNonEmptyString),
});
export type NativeForkInput = typeof NativeForkInput.Type;
