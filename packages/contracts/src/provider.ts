import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderModelOptions } from "./model";
import { ProviderInstanceId } from "./providerInstance";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas";
import {
  ChatAttachment,
  ModelSelection,
  ProjectMemory,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderKind,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderStartOptions,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadSessionNotes,
} from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  provider: Schema.optional(ProviderKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  projectTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  threadTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  turnCount: Schema.optional(NonNegativeInt),
  priorWorkSummary: Schema.optional(TrimmedNonEmptyStringSchema),
  preservedTranscriptBefore: Schema.optional(TrimmedNonEmptyStringSchema),
  preservedTranscriptAfter: Schema.optional(TrimmedNonEmptyStringSchema),
  restoredRecentFileRefs: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  restoredActivePlan: Schema.optional(TrimmedNonEmptyStringSchema),
  restoredTasks: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  sessionNotes: Schema.optional(ThreadSessionNotes),
  projectMemories: Schema.optional(Schema.Array(ProjectMemory)),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  modelOptions: Schema.optional(ProviderModelOptions),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  modelOptions: Schema.optional(ProviderModelOptions),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyStringSchema,
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
