import { ScheduledOrigin } from "../baseSchemas";
import { OrchestrationProposedPlan } from "../proposedPlan";
import { FilesystemPath } from "../baseSchemas";
import { SourceControlPullRequestRef } from "../sourceControl";
import { Schema } from "effect";
import { CodeReviewWorkflow, CodeReviewWorkflowId } from "../codeReviewWorkflow";
import { InvestigationWorkflow, InvestigationWorkflowId } from "../investigationWorkflow";
import { ProviderModelOptions } from "../model";
import { PlanningWorkflow, PlanningWorkflowId } from "../planningWorkflow";
import { ProviderStartOptions } from "../providerStartOptions";
import { ProjectIcon } from "../project";
import { ThreadEnvMode } from "../threadEnvMode";
import { UsageTurnFact } from "../usage";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas";
export {
  CLAUDE_SUBAGENT_EFFORT_OPTIONS,
  type ClaudeSubagentEffort,
  ClaudeProviderStartOptions,
  ClaudeThinkingDisplay,
  ClaudeThinkingOption,
  ProviderStartOptions,
} from "../providerStartOptions";

import {
  ProviderKind,
  MAX_PINNED_THREADS,
  ModelSelection,
  RuntimeMode,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  WorkflowTurnExecutionProfile,
  AssistantDeliveryMode,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ChatAttachment,
  ProjectScript,
  ProjectMemory,
  ProjectSkill,
  ProjectKind,
  OrchestrationMessageRole,
  UserMessageSkillCall,
  OrchestrationMessage,
  TaskItem,
  ThreadTaskTracking,
  ThreadCompactionDirection,
  ThreadCompactionTrigger,
  ThreadCompaction,
  ThreadReference,
  ThreadSessionNotes,
  OrchestrationCommandExecutionId,
  CommandExecutionRecordWithoutThread,
  FileChangeRecordWithoutThread,
  SourceProposedPlanReference,
  OrchestrationSession,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationThreadActivity,
  ThreadTitleSource,
  ThreadTitleState,
  ThreadTitleRegeneration,
  ThreadSettledBy,
  ThreadPullRequestLink,
} from "./readModel";
import {
  ThreadTurnStartCommand,
  ThreadConversationRevertCommand,
  RewindDraftResolveIntent,
} from "./commands";

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "project.memory-saved",
  "project.memory-updated",
  "project.memory-deleted",
  "project.skills-replaced",
  "project.workflow-created",
  "project.workflow-upserted",
  "project.workflow-deleted",
  "project.code-review-workflow-created",
  "project.code-review-workflow-upserted",
  "project.code-review-workflow-deleted",
  "project.investigation-workflow-created",
  "project.investigation-workflow-upserted",
  "project.investigation-workflow-deleted",
  "project.debug-workflow-created",
  "project.debug-workflow-upserted",
  "project.debug-workflow-deleted",
  "thread.created",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.auto-settle-changed",
  "thread.archived",
  "thread.unarchived",
  "thread.pins-replaced",
  "thread.legacy-pins-imported",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.meta-updated",
  "thread.title-regeneration-started",
  "thread.title-regenerated",
  "thread.title-regeneration-failed",
  "thread.title-regeneration-discarded",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.message-reasoning-tokens-added",
  "thread.turn-start-requested",
  "thread.turn-steer-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.user-input-resolved",
  "thread.checkpoint-revert-requested",
  "thread.conversation-revert-requested",
  "thread.rewind-draft-resolved",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.turn-processing-quiesced",
  "thread.activity-appended",
  "thread.tasks.updated",
  "thread.compact-requested",
  "thread.compacted",
  "thread.session-notes-recorded",
  "thread.command-execution-recorded",
  "thread.command-execution-output-appended",
  "thread.command-execution-output-reconciled",
  "thread.file-change-recorded",
  "thread.usage-recorded",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "standard" as const)),
  title: TrimmedNonEmptyString,
  workspaceRoot: FilesystemPath,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  defaultEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  icon: Schema.optional(Schema.NullOr(ProjectIcon)).pipe(Schema.withDecodingDefault(() => null)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(FilesystemPath),
  defaultModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  icon: Schema.optional(Schema.NullOr(ProjectIcon)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ProjectMemorySavedPayload = Schema.Struct({
  projectId: ProjectId,
  memory: ProjectMemory,
});

export const ProjectMemoryUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  memory: ProjectMemory,
});

export const ProjectMemoryDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  memoryId: TrimmedNonEmptyString,
  deletedAt: IsoDateTime,
});

export const ProjectSkillsReplacedPayload = Schema.Struct({
  projectId: ProjectId,
  skills: Schema.Array(ProjectSkill),
  updatedAt: IsoDateTime,
});

export const ProjectWorkflowCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  workflow: PlanningWorkflow,
});

export const ProjectWorkflowUpsertedPayload = Schema.Struct({
  projectId: ProjectId,
  workflow: PlanningWorkflow,
});

export const ProjectWorkflowDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  workflowId: PlanningWorkflowId,
  deletedAt: IsoDateTime,
});

export const ProjectCodeReviewWorkflowCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  workflow: CodeReviewWorkflow,
});

export const ProjectCodeReviewWorkflowUpsertedPayload = Schema.Struct({
  projectId: ProjectId,
  workflow: CodeReviewWorkflow,
});

export const ProjectCodeReviewWorkflowDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  workflowId: CodeReviewWorkflowId,
  deletedAt: IsoDateTime,
});

export const ProjectInvestigationWorkflowCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  workflow: InvestigationWorkflow,
});

export const ProjectInvestigationWorkflowUpsertedPayload = Schema.Struct({
  projectId: ProjectId,
  workflow: InvestigationWorkflow,
});

export const ProjectInvestigationWorkflowDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  workflowId: InvestigationWorkflowId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  sideChatOf: Schema.optional(Schema.NullOr(ThreadId)),
  scheduledOrigin: Schema.optional(Schema.NullOr(ScheduledOrigin)),
  pullRequest: Schema.optional(ThreadPullRequestLink),
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(FilesystemPath),
  scratchPath: Schema.optional(Schema.NullOr(FilesystemPath)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  threadReferences: Schema.optional(Schema.Array(ThreadReference)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  titleSource: Schema.optional(ThreadTitleSource).pipe(
    Schema.withDecodingDefault(() => "legacy" as const),
  ),
  titleRevision: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  titleUpdatedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
  pinRevision: Schema.optional(NonNegativeInt),
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  settledBy: ThreadSettledBy,
});
export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity", "wake"]),
});
export const ThreadAutoSettleChangedPayload = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  pinRevision: Schema.optional(NonNegativeInt),
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  unarchivedAt: IsoDateTime,
});

export const ThreadPinsReplacedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  pinRevision: NonNegativeInt,
  updatedAt: IsoDateTime,
});

export const ThreadLegacyPinsImportedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  pinRevision: NonNegativeInt,
  acceptedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  overflowedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  unknownThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  pinRevision: Schema.optional(NonNegativeInt),
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  unsnoozedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  pullRequest: Schema.optional(ThreadPullRequestLink),
  pullRequestUnlinked: Schema.optional(SourceControlPullRequestRef),
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  titleOrigin: Schema.optional(Schema.Literals(["host", "provider"])),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  titleSource: Schema.optional(ThreadTitleSource),
  titleRevision: Schema.optional(NonNegativeInt),
  titleUpdatedAt: Schema.optional(IsoDateTime),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  deferModelSwitch: Schema.optional(Schema.Literal(true)),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(FilesystemPath)),
  updatedAt: IsoDateTime,
});

export const ThreadTitleRegenerationStartedPayload = Schema.Struct({
  threadId: ThreadId,
  titleRegeneration: ThreadTitleRegeneration,
  expectedTitleRevision: NonNegativeInt,
  origin: Schema.Literals(["first-turn", "explicit", "auto-refine"]),
  refinementTurn: Schema.optional(NonNegativeInt),
  titleState: Schema.optional(ThreadTitleState),
  titleSourceText: Schema.optional(Schema.String),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  titleGenerationModelSelection: Schema.optional(ModelSelection),
});

export const ThreadTitleRegeneratedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: CommandId,
  title: TrimmedNonEmptyString,
  titleSource: Schema.Literal("generated"),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  titleRevision: NonNegativeInt,
  titleUpdatedAt: IsoDateTime,
});

export const ThreadTitleRegenerationFailedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: CommandId,
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  failedAt: IsoDateTime,
});

export const ThreadTitleRegenerationDiscardedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: CommandId,
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  discardedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  replace: Schema.optional(Schema.Literal(true)),
  authorship: OrchestrationMessage.fields.authorship,
  reasoningText: Schema.optional(Schema.String),
  skillCall: Schema.optional(UserMessageSkillCall),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  // Older persisted messages predate turn IDs.
  turnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadMessageReasoningTokensAddedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: TurnId,
  tokens: NonNegativeInt,
  estimated: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  freshContext: Schema.optional(Schema.Boolean),
  continuationRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),

  expectedTurnId: Schema.optional(TurnId),
  presentation: Schema.optional(Schema.Literal("continuation")),
  threadId: ThreadId,
  messageId: MessageId,
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  titleGenerationModelSelection: Schema.optional(ModelSelection),
  titleSourceText: Schema.optional(Schema.String),
  modelOptions: Schema.optional(ProviderModelOptions),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  workflowExecutionProfile: Schema.optional(WorkflowTurnExecutionProfile),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

export const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadUserInputResolvedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  resolution: Schema.Literals(["answered", "dismissed"]),
  answers: Schema.optional(ProviderUserInputAnswers),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  deliveryQueueItemId: Schema.optional(CommandId),
  command: Schema.optional(ThreadTurnStartCommand),
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  /** Native reconciliation removes only strongly identified abandoned turns. */
  removedTurnIds: Schema.optional(Schema.Array(TurnId).check(Schema.isMaxLength(500))),
  nativeTurnId: Schema.optional(TurnId),
  removedMessageIds: Schema.optional(Schema.Array(MessageId).check(Schema.isMaxLength(1000))),
  /** Verified delivery bindings shared by live projection and event replay. */
  retainedMessageIds: Schema.optional(Schema.Array(MessageId)),
  retainedTurnIds: Schema.optional(Schema.Array(TurnId)),
  operationId: Schema.optional(CommandId),
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
  settledTurnId: Schema.optional(TurnId),
  usageFact: Schema.optional(UsageTurnFact),
});

export const ThreadUsageRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  usageFact: UsageTurnFact,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadTurnProcessingQuiescedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  processingQuiescedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadTasksUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  tasks: Schema.Array(TaskItem),
  turnId: Schema.NullOr(TurnId),
  tracking: Schema.optional(Schema.NullOr(ThreadTaskTracking)),
  updatedAt: IsoDateTime,
});

export const ThreadCompactRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  trigger: ThreadCompactionTrigger,
  direction: Schema.NullOr(ThreadCompactionDirection).pipe(Schema.withDecodingDefault(() => null)),
  pivotMessageId: Schema.NullOr(MessageId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
});

export const ThreadCompactedPayload = Schema.Struct({
  threadId: ThreadId,
  compaction: ThreadCompaction,
});

export const ThreadSessionNotesRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  sessionNotes: ThreadSessionNotes,
});

export const ThreadCommandExecutionRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  commandExecution: CommandExecutionRecordWithoutThread,
});

export const ThreadCommandExecutionOutputAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
  chunk: Schema.String,
  updatedAt: IsoDateTime,
  /**
   * Set when event compaction replaced this command's output events with one
   * head-and-tail copy, so a projection rebuilt from events still marks the
   * output as truncated.
   */
  outputTruncated: Schema.optional(Schema.Boolean),
});

export const ThreadCommandExecutionOutputReconciledPayload = Schema.Struct({
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
  /** The projection ignores this event unless the row's last update is still this one. */
  expectedLastUpdatedSequence: NonNegativeInt,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const ThreadFileChangeRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  fileChange: Schema.Struct({
    ...FileChangeRecordWithoutThread.fields,
    patch: Schema.String,
  }),
});

export const OrchestrationEventMetadata = Schema.Struct({
  /** Historical messages do not represent a new turn or checkpoint request. */
  source: Schema.optional(Schema.Literal("agent-history-import")),
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

export const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.memory-saved"),
    payload: ProjectMemorySavedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.memory-updated"),
    payload: ProjectMemoryUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.memory-deleted"),
    payload: ProjectMemoryDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.skills-replaced"),
    payload: ProjectSkillsReplacedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.workflow-created"),
    payload: ProjectWorkflowCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.workflow-upserted"),
    payload: ProjectWorkflowUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.workflow-deleted"),
    payload: ProjectWorkflowDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.code-review-workflow-created"),
    payload: ProjectCodeReviewWorkflowCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.code-review-workflow-upserted"),
    payload: ProjectCodeReviewWorkflowUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.code-review-workflow-deleted"),
    payload: ProjectCodeReviewWorkflowDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literals([
      "project.investigation-workflow-created",
      "project.debug-workflow-created",
    ]),
    payload: ProjectInvestigationWorkflowCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literals([
      "project.investigation-workflow-upserted",
      "project.debug-workflow-upserted",
    ]),
    payload: ProjectInvestigationWorkflowUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literals([
      "project.investigation-workflow-deleted",
      "project.debug-workflow-deleted",
    ]),
    payload: ProjectInvestigationWorkflowDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.auto-settle-changed"),
    payload: ThreadAutoSettleChangedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pins-replaced"),
    payload: ThreadPinsReplacedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.legacy-pins-imported"),
    payload: ThreadLegacyPinsImportedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.title-regeneration-started"),
    payload: ThreadTitleRegenerationStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.title-regenerated"),
    payload: ThreadTitleRegeneratedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.title-regeneration-failed"),
    payload: ThreadTitleRegenerationFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.title-regeneration-discarded"),
    payload: ThreadTitleRegenerationDiscardedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-reasoning-tokens-added"),
    payload: ThreadMessageReasoningTokensAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-steer-requested"),
    payload: Schema.Struct({
      ...ThreadTurnStartRequestedPayload.fields,
      expectedTurnId: TurnId,
      expectedSessionGeneration: Schema.optional(NonNegativeInt),
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-resolved"),
    payload: ThreadUserInputResolvedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-revert-requested"),
    payload: Schema.Struct({ ...ThreadConversationRevertCommand.fields }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.rewind-draft-resolved"),
    payload: Schema.Struct({
      operationId: CommandId,
      threadId: ThreadId,
      intent: Schema.optional(RewindDraftResolveIntent),
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.usage-recorded"),
    payload: ThreadUsageRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-processing-quiesced"),
    payload: ThreadTurnProcessingQuiescedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.tasks.updated"),
    payload: ThreadTasksUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.compact-requested"),
    payload: ThreadCompactRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.compacted"),
    payload: ThreadCompactedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-notes-recorded"),
    payload: ThreadSessionNotesRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.command-execution-recorded"),
    payload: ThreadCommandExecutionRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.command-execution-output-appended"),
    payload: ThreadCommandExecutionOutputAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.command-execution-output-reconciled"),
    payload: ThreadCommandExecutionOutputReconciledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.file-change-recorded"),
    payload: ThreadFileChangeRecordedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;
