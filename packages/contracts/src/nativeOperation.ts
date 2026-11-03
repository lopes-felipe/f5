import { ProviderInstanceId } from "./providerInstance";
import { FilesystemPath } from "./baseSchemas";
import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

// Schema constructors are pure; unused server request/response schemas must not
// execute in the browser merely because it imports the WebSocket method names.
export const NativeOperationState = /* @__PURE__ */ Schema.Literals([
  "requested",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);
export type NativeOperationState = typeof NativeOperationState.Type;
export const NativeReviewTarget = /* @__PURE__ */ Schema.Union([
  /* @__PURE__ */ Schema.Struct({ type: /* @__PURE__ */ Schema.Literal("uncommittedChanges") }),
  /* @__PURE__ */ Schema.Struct({
    type: /* @__PURE__ */ Schema.Literal("baseBranch"),
    branch: TrimmedNonEmptyString,
  }),
  /* @__PURE__ */ Schema.Struct({
    type: /* @__PURE__ */ Schema.Literal("commit"),
    sha: TrimmedNonEmptyString,
  }),
]);
export const NativeOperationCommand = /* @__PURE__ */ Schema.Union([
  /* @__PURE__ */ Schema.Struct({
    kind: /* @__PURE__ */ Schema.Literal("aside"),
    question: /* @__PURE__ */ TrimmedNonEmptyString.check(/* @__PURE__ */ Schema.isMaxLength(8000)),
  }),
  /* @__PURE__ */ Schema.Struct({ kind: /* @__PURE__ */ Schema.Literal("compact") }),
  /* @__PURE__ */ Schema.Struct({
    kind: /* @__PURE__ */ Schema.Literal("review"),
    target: NativeReviewTarget,
  }),
  /* @__PURE__ */ Schema.Struct({
    kind: /* @__PURE__ */ Schema.Literal("stopTask"),
    taskId: TrimmedNonEmptyString,
    runId: /* @__PURE__ */ Schema.optional(TrimmedNonEmptyString),
  }),
  /* @__PURE__ */ Schema.Struct({
    kind: /* @__PURE__ */ Schema.Literal("revertFiles"),
    userMessageId: TrimmedNonEmptyString,
  }),
  /* @__PURE__ */ Schema.Struct({
    kind: /* @__PURE__ */ Schema.Literal("fork"),
    targetThreadId: ThreadId,
    cwd: FilesystemPath,
    beforeTurnId: /* @__PURE__ */ Schema.optional(TrimmedNonEmptyString),
  }),
  /* @__PURE__ */ Schema.Struct({
    kind: /* @__PURE__ */ Schema.Literal("goalSet"),
    objective: /* @__PURE__ */ TrimmedNonEmptyString.check(
      /* @__PURE__ */ Schema.isMaxLength(16000),
    ),
    tokenBudget: /* @__PURE__ */ PositiveInt.check(
      /* @__PURE__ */ Schema.isLessThanOrEqualTo(10000000),
    ),
  }),
  /* @__PURE__ */ Schema.Struct({ kind: /* @__PURE__ */ Schema.Literal("goalPause") }),
  /* @__PURE__ */ Schema.Struct({ kind: /* @__PURE__ */ Schema.Literal("goalClear") }),
]);
export type NativeOperationCommand = typeof NativeOperationCommand.Type;
export const NativeOperationInput = /* @__PURE__ */ Schema.Struct({
  threadId: ThreadId,
  operationId: /* @__PURE__ */ TrimmedNonEmptyString.check(/* @__PURE__ */ Schema.isMaxLength(200)),
  generation: NonNegativeInt,
  command: NativeOperationCommand,
});
export type NativeOperationInput = typeof NativeOperationInput.Type;
export const NativeOperationRecord = /* @__PURE__ */ Schema.Struct({
  ...NativeOperationInput.fields,
  state: NativeOperationState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  applicationRequired: /* @__PURE__ */ Schema.optional(Schema.Boolean),
  applicationApplied: /* @__PURE__ */ Schema.optional(Schema.Boolean),
  receipt: /* @__PURE__ */ Schema.optional(Schema.Unknown),
  result: /* @__PURE__ */ Schema.optional(Schema.Unknown),
  error: /* @__PURE__ */ Schema.optional(Schema.String),
  staleGeneration: /* @__PURE__ */ Schema.optional(Schema.Boolean),
});
export type NativeOperationRecord = typeof NativeOperationRecord.Type;
export const NativeOperationListInput = /* @__PURE__ */ Schema.Struct({ threadId: ThreadId });
export const NativeOperationInspectInput = /* @__PURE__ */ Schema.Struct({
  threadId: ThreadId,
  generation: NonNegativeInt,
  kind: /* @__PURE__ */ Schema.Literals([
    "task",
    "filePreview",
    "goal",
    "attachments",
    "memory",
    "usage",
  ]),
  nativeId: /* @__PURE__ */ Schema.optional(TrimmedNonEmptyString),
  runId: /* @__PURE__ */ Schema.optional(TrimmedNonEmptyString),
  cursor: /* @__PURE__ */ Schema.optional(
    /* @__PURE__ */ Schema.String.check(/* @__PURE__ */ Schema.isMaxLength(2048)),
  ),
  limit: /* @__PURE__ */ Schema.optional(
    /* @__PURE__ */ NonNegativeInt.check(
      /* @__PURE__ */ Schema.isBetween({ minimum: 1, maximum: 50 }),
    ),
  ),
});
export type NativeOperationInspectInput = typeof NativeOperationInspectInput.Type;
export const NativeFileRewindPreview = /* @__PURE__ */ Schema.Struct({
  canRewind: Schema.Boolean,
  error: /* @__PURE__ */ Schema.optional(Schema.String),
  filesChanged: /* @__PURE__ */ Schema.optional(Schema.Array(Schema.String)),
  insertions: /* @__PURE__ */ Schema.optional(NonNegativeInt),
  deletions: /* @__PURE__ */ Schema.optional(NonNegativeInt),
  skippedLinks: /* @__PURE__ */ Schema.optional(NonNegativeInt),
});
export type NativeFileRewindPreview = typeof NativeFileRewindPreview.Type;
export const NativeOperationResolutionInput = /* @__PURE__ */ Schema.Struct({
  threadId: ThreadId,
  operationId: /* @__PURE__ */ TrimmedNonEmptyString.check(/* @__PURE__ */ Schema.isMaxLength(200)),
  generation: NonNegativeInt,
  action: /* @__PURE__ */ Schema.Literals(["reconcile", "acknowledge", "cancel"]),
});
export type NativeOperationResolutionInput = typeof NativeOperationResolutionInput.Type;
export const NATIVE_OPERATION_WS_METHODS = {
  markRead: "nativeOperation.markRead",
  historyRecovery: "nativeOperation.historyRecovery",
  resolve: "nativeOperation.resolve",
  fork: "nativeOperation.fork",
  execute: "nativeOperation.execute",
  list: "nativeOperation.list",
  inspect: "nativeOperation.inspect",
} as const;

export const NativeForkInput = /* @__PURE__ */ Schema.Struct({
  threadId: ThreadId,
  operationId: /* @__PURE__ */ TrimmedNonEmptyString.check(/* @__PURE__ */ Schema.isMaxLength(200)),
  generation: NonNegativeInt,
  beforeTurnId: /* @__PURE__ */ Schema.optional(TrimmedNonEmptyString),
});
export type NativeForkInput = typeof NativeForkInput.Type;

/** Explicit acceptance of incomplete output is fenced to the inspected source. */
export const NativeHistoryRecovery = /* @__PURE__ */ Schema.Struct({
  instanceId: ProviderInstanceId,
  generation: NonNegativeInt,
  eventId: TrimmedNonEmptyString,
});
export type NativeHistoryRecovery = typeof NativeHistoryRecovery.Type;
export const NativeHistoryRecoveryInput = /* @__PURE__ */ Schema.Struct({
  threadId: ThreadId,
  action: /* @__PURE__ */ Schema.Literals(["inspect", "acknowledge"]),
  expected: /* @__PURE__ */ Schema.optional(NativeHistoryRecovery),
});
export type NativeHistoryRecoveryInput = typeof NativeHistoryRecoveryInput.Type;
