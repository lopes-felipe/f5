import { ScheduledOrigin } from "../baseSchemas";
import { ImportedSessionMessages } from "../agentSessions";
import { OrchestrationProposedPlan } from "../proposedPlan";
import { FilesystemPath } from "../baseSchemas";
import { SourceControlPullRequestRef } from "../sourceControl";
import { Schema } from "effect";
import {
  CodeReviewPullRequest,
  CodeReviewWorkflow,
  CodeReviewWorkflowId,
} from "../codeReviewWorkflow";
import { InvestigationWorkflow, InvestigationWorkflowId } from "../investigationWorkflow";
import { ProviderModelOptions } from "../model";
import {
  DocumentReaderPersona,
  WorkflowDocumentType,
  PlanningWorkflow,
  PlanningWorkflowId,
  WorkflowModelSlot,
} from "../planningWorkflow";
import {
  CODE_REVIEW_PROMPT_MAX_CHARS,
  WORKFLOW_MAX_ADDITIONAL_PARTICIPANTS,
} from "../workflowParticipants";
import { ProviderInstanceId } from "../providerInstance";
import { ProviderStartOptions } from "../providerStartOptions";
import { ProjectIcon } from "../project";
import { ThreadEnvMode } from "../threadEnvMode";
import { UsageTurnFact } from "../usage";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
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
  ProviderTurnInputText,
  ChatAttachment,
  UploadChatAttachment,
  ProjectScript,
  ProjectMemoryScope,
  ProjectMemoryType,
  ProjectSkill,
  UserMessageSkillCall,
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
  ThreadSettledBy,
  ThreadPullRequestLink,
} from "./readModel";

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: FilesystemPath,
  defaultModel: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(ModelSelection),
  defaultEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  icon: Schema.optional(Schema.NullOr(ProjectIcon)),
  createdAt: IsoDateTime,
});

export const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(FilesystemPath),
  defaultModel: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  icon: Schema.optional(Schema.NullOr(ProjectIcon)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

export const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

export const ProjectMemorySaveCommand = Schema.Struct({
  type: Schema.Literal("project.memory.save"),
  commandId: CommandId,
  projectId: ProjectId,
  memoryId: TrimmedNonEmptyString,
  scope: ProjectMemoryScope,
  memoryType: ProjectMemoryType,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ProjectMemoryUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.memory.update"),
  commandId: CommandId,
  projectId: ProjectId,
  memoryId: TrimmedNonEmptyString,
  scope: ProjectMemoryScope,
  memoryType: ProjectMemoryType,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ProjectMemoryDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.memory.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  memoryId: TrimmedNonEmptyString,
  deletedAt: IsoDateTime,
});

export const ProjectSkillsReplaceCommand = Schema.Struct({
  type: Schema.Literal("project.skills.replace"),
  commandId: CommandId,
  projectId: ProjectId,
  skills: Schema.Array(ProjectSkill),
  updatedAt: IsoDateTime,
});

export const ProjectWorkflowCreateCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.create"),
  commandId: CommandId,
  workflowId: PlanningWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  requirementPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(80_000)),
  plansDirectory: FilesystemPath,
  templateId: Schema.optional(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => "builtin.planning.dual"),
  ),
  templateVersion: Schema.optional(Schema.Int).pipe(Schema.withDecodingDefault(() => 1)),
  documentType: Schema.optional(WorkflowDocumentType),
  readerReviewEnabled: Schema.optional(Schema.Boolean),
  readerPersona: Schema.optional(DocumentReaderPersona),
  readerSlot: Schema.optional(WorkflowModelSlot),
  authorThreadIdA: ThreadId,
  authorThreadIdB: ThreadId,
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  branchA: WorkflowModelSlot,
  branchB: WorkflowModelSlot,
  /** Authors beyond A and B, in roster order, each with its pre-minted thread. */
  additionalBranches: Schema.optional(
    Schema.Array(Schema.Struct({ authorSlot: WorkflowModelSlot, authorThreadId: ThreadId })).check(
      Schema.isMaxLength(WORKFLOW_MAX_ADDITIONAL_PARTICIPANTS),
    ),
  ),
  merge: WorkflowModelSlot,
  maxCostUsd: Schema.optional(Schema.NullOr(Schema.Number)),
  createdAt: IsoDateTime,
});

export const ProjectWorkflowDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.delete"),
  commandId: CommandId,
  workflowId: PlanningWorkflowId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  deleteThreads: Schema.optional(Schema.Boolean),
});

export const ProjectCodeReviewWorkflowCreateCommand = Schema.Struct({
  type: Schema.Literal("project.code-review-workflow.create"),
  commandId: CommandId,
  workflowId: CodeReviewWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  reviewPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(CODE_REVIEW_PROMPT_MAX_CHARS)),
  templateId: Schema.optional(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => "builtin.code-review.dual"),
  ),
  templateVersion: Schema.optional(Schema.Int).pipe(Schema.withDecodingDefault(() => 1)),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  reviewerA: WorkflowModelSlot,
  reviewerB: WorkflowModelSlot,
  consolidation: WorkflowModelSlot,
  maxCostUsd: Schema.optional(Schema.NullOr(Schema.Number)),
  pullRequest: Schema.optional(Schema.NullOr(CodeReviewPullRequest)),
  autoPost: Schema.optional(Schema.Boolean),
  reviewerThreadIdA: ThreadId,
  reviewerThreadIdB: ThreadId,
  /** Reviewers beyond A and B, in roster order, each with its pre-minted thread. */
  additionalReviewers: Schema.optional(
    Schema.Array(Schema.Struct({ slot: WorkflowModelSlot, threadId: ThreadId })).check(
      Schema.isMaxLength(WORKFLOW_MAX_ADDITIONAL_PARTICIPANTS),
    ),
  ),
  createdAt: IsoDateTime,
});

export const ProjectCodeReviewWorkflowUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.code-review-workflow.upsert"),
  commandId: CommandId,
  projectId: ProjectId,
  workflow: CodeReviewWorkflow,
  updatedAt: IsoDateTime,
});

export const ProjectCodeReviewWorkflowDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.code-review-workflow.delete"),
  commandId: CommandId,
  workflowId: CodeReviewWorkflowId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  deleteThreads: Schema.optional(Schema.Boolean),
});

export const ProjectInvestigationWorkflowCreateCommand = Schema.Struct({
  type: Schema.Literals(["project.investigation-workflow.create", "project.debug-workflow.create"]),
  commandId: CommandId,
  workflowId: InvestigationWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  problemPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(80_000)),
  templateId: Schema.optional(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => "builtin.investigation.dual"),
  ),
  templateVersion: Schema.optional(Schema.Int).pipe(Schema.withDecodingDefault(() => 1)),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  investigatorA: WorkflowModelSlot,
  investigatorB: WorkflowModelSlot,
  synthesis: WorkflowModelSlot,
  maxCostUsd: Schema.optional(Schema.NullOr(Schema.Number)),
  investigationThreadIdA: ThreadId,
  investigationThreadIdB: ThreadId,
  /** Investigators beyond A and B, in roster order, each with its pre-minted thread. */
  additionalInvestigators: Schema.optional(
    Schema.Array(Schema.Struct({ slot: WorkflowModelSlot, investigationThreadId: ThreadId })).check(
      Schema.isMaxLength(WORKFLOW_MAX_ADDITIONAL_PARTICIPANTS),
    ),
  ),
  createdAt: IsoDateTime,
});

export const ProjectInvestigationWorkflowUpsertCommand = Schema.Struct({
  type: Schema.Literals(["project.investigation-workflow.upsert", "project.debug-workflow.upsert"]),
  commandId: CommandId,
  projectId: ProjectId,
  workflow: InvestigationWorkflow,
  updatedAt: IsoDateTime,
});

export const ProjectInvestigationWorkflowDeleteCommand = Schema.Struct({
  type: Schema.Literals(["project.investigation-workflow.delete", "project.debug-workflow.delete"]),
  commandId: CommandId,
  workflowId: InvestigationWorkflowId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  deleteThreads: Schema.optional(Schema.Boolean),
});

export const ThreadCreateCommand = Schema.Struct({
  sideChatOf: Schema.optional(Schema.NullOr(ThreadId)),
  scheduledOrigin: Schema.optional(Schema.NullOr(ScheduledOrigin)),
  sharedFilesystemConfirmed: Schema.optional(Schema.Boolean),
  pullRequest: Schema.optional(ThreadPullRequestLink),
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(FilesystemPath),
  /** Allocated by the engine for scratch threads; a client value is discarded. */
  scratchPath: Schema.optional(Schema.NullOr(FilesystemPath)),
  /** Text whose first words name a scratch thread's folder; defaults to the title. */
  scratchFolderWords: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  threadReferences: Schema.optional(Schema.Array(ThreadReference)),
  createdAt: IsoDateTime,
});

export const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedArchivedAt: Schema.optional(IsoDateTime),
  expectedWorktreePath: Schema.optional(Schema.NullOr(FilesystemPath)),
});

export const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  settledBy: Schema.optional(ThreadSettledBy),
  settledAt: Schema.optional(IsoDateTime),
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  reason: Schema.optional(Schema.Literals(["user", "activity", "wake"])),
});
export const ThreadAutoSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle.set"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  enabled: Schema.Boolean,
});

export const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  cleanupExpectation: Schema.optional(
    Schema.Struct({
      worktreePath: FilesystemPath,
      lastInteractionAt: IsoDateTime,
      sessionUpdatedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
});

export const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadPinsReplaceCommand = Schema.Struct({
  type: Schema.Literal("thread.pins.replace"),
  commandId: CommandId,
  threadId: ThreadId,
  pinnedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  expectedRevision: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadLegacyPinsImportCommand = Schema.Struct({
  type: Schema.Literal("thread.pins.import-legacy"),
  commandId: CommandId,
  threadId: ThreadId,
  legacyThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(MAX_PINNED_THREADS)),
  expectedRevision: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  until: IsoDateTime,
  createdAt: IsoDateTime,
});

export const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedSnoozedUntil: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
});

export const ThreadMetaUpdateCommand = Schema.Struct({
  pullRequest: Schema.optional(ThreadPullRequestLink),
  /** Removes this PR link from the thread. Exclusive with `pullRequest`. */
  pullRequestUnlink: Schema.optional(SourceControlPullRequestRef),
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  titleOrigin: Schema.optional(Schema.Literals(["host", "provider"])),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  /** Save the composer's next-turn choice without refreshing the live session. */
  deferModelSwitch: Schema.optional(Schema.Literal(true)),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(FilesystemPath)),
  expectedArchivedAt: Schema.optional(IsoDateTime),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedWorktreePath: Schema.optional(Schema.NullOr(FilesystemPath)),
}).check(
  Schema.makeFilter(
    (input) =>
      input.regenerateTitle !== true ||
      (input.title === undefined &&
        input.model === undefined &&
        input.modelSelection === undefined &&
        input.branch === undefined &&
        input.worktreePath === undefined &&
        input.pullRequest === undefined) ||
      "regenerateTitle cannot be combined with other metadata changes",
  ),
);

export const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

export const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  scheduledOrigin: Schema.optional(Schema.NullOr(ScheduledOrigin)),
  sharedFilesystemConfirmed: Schema.optional(Schema.Boolean),
  pullRequest: Schema.optional(ThreadPullRequestLink),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(FilesystemPath),
  createdAt: IsoDateTime,
});
export type ThreadTurnStartBootstrapCreateThread = typeof ThreadTurnStartBootstrapCreateThread.Type;

export const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  namingIntent: Schema.optional(Schema.Literals(["auto", "explicit"])),
  runSetupScript: Schema.optional(Schema.Boolean),
  projectCwd: FilesystemPath,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  repositoryPaths: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(128)),
  ),
  /**
   * Reject the send, before the thread exists, when no separate worktree can
   * be prepared, instead of falling back to the project checkout. Multi-model
   * fan-out sets it so parallel agents never share one checkout.
   */
  requireWorktree: Schema.optional(Schema.Boolean),
});
export type ThreadTurnStartBootstrapPrepareWorktree =
  typeof ThreadTurnStartBootstrapPrepareWorktree.Type;

export const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  freshContext: Schema.optional(Schema.Boolean),
  /** Server-only identity; intentionally absent from ClientThreadTurnStartCommand. */
  continuationRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),

  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: ProviderTurnInputText,
    skillCall: Schema.optional(UserMessageSkillCall),
    attachments: Schema.Array(ChatAttachment),
  }),
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
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  expectedTurnId: Schema.optional(TurnId),
  presentation: Schema.optional(Schema.Literal("continuation")),
  dispatchSource: Schema.optional(Schema.Literal("next-turn-queue")),
  /**
   * Server-only: reject instead of applying settings when the thread's model or
   * modes differ from the command's. Thread-bound scheduled turns use it.
   */
  requireCurrentSettings: Schema.optional(Schema.Literal(true)),
  createdAt: IsoDateTime,
});
export type ThreadTurnStartCommand = typeof ThreadTurnStartCommand.Type;

export const ThreadTurnSteerCommand = Schema.Struct({
  ...ThreadTurnStartCommand.fields,
  type: Schema.Literal("thread.turn.steer"),
  expectedTurnId: TurnId,
  /**
   * Session generation the browser saw. The server refuses the action with
   * `stale-generation` when the provider session restarted since then.
   */
  expectedSessionGeneration: Schema.optional(NonNegativeInt),
});
export type ThreadTurnSteerCommand = typeof ThreadTurnSteerCommand.Type;

export const ClientThreadTurnStartCommand = Schema.Struct({
  freshContext: Schema.optional(Schema.Boolean),
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: ProviderTurnInputText,
    skillCall: Schema.optional(UserMessageSkillCall),
    attachments: Schema.Array(UploadChatAttachment),
  }),
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  titleGenerationModelSelection: Schema.optional(ModelSelection),
  titleSourceText: Schema.optional(Schema.String),
  modelOptions: Schema.optional(ProviderModelOptions),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  expectedTurnId: Schema.optional(TurnId),
  presentation: Schema.optional(Schema.Literal("continuation")),
  dispatchSource: Schema.optional(Schema.Literal("next-turn-queue")),
  createdAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ClientThreadTurnStartCommand = typeof ClientThreadTurnStartCommand.Type;

export const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

export const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  createdAt: IsoDateTime,
});

export const ThreadUserInputDismissCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.dismiss"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
});

export const ThreadConversationRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.revert"),
  commandId: CommandId,
  operationId: CommandId,
  threadId: ThreadId,
  targetMessageId: MessageId,
  restoreFiles: Schema.Boolean,
  /** @deprecated Global snapshot sequence; any thread's activity invalidates it. */
  expectedRevision: Schema.optional(NonNegativeInt),
  /**
   * The newest message the user saw when confirming. The revert is rejected if
   * this thread has moved on since, without being affected by other threads.
   */
  expectedLatestMessageId: Schema.optional(MessageId),
  /**
   * Session generation the browser saw. The server refuses the action with
   * `stale-generation` when the provider session restarted since then.
   */
  expectedSessionGeneration: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
/**
 * `resolve` (the default) releases a completed rewind's recovered draft.
 * `cancel` abandons an untouched rewind, or an uncertain native file rewind whose
 * native operation was explicitly acknowledged after stopping the provider.
 * Completed drafts are released only by `resolve`.
 */
export const RewindDraftResolveIntent = Schema.Literals(["resolve", "cancel"]);
export type RewindDraftResolveIntent = typeof RewindDraftResolveIntent.Type;

export const ThreadRewindDraftResolveCommand = Schema.Struct({
  type: Schema.Literal("thread.rewind-draft.resolve"),
  commandId: CommandId,
  operationId: CommandId,
  threadId: ThreadId,
  intent: Schema.optional(RewindDraftResolveIntent),
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadCompactRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.compact.request"),
  commandId: CommandId,
  threadId: ThreadId,
  trigger: ThreadCompactionTrigger.pipe(Schema.withDecodingDefault(() => "manual" as const)),
  direction: Schema.optional(ThreadCompactionDirection),
  pivotMessageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});

export const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ProjectMemorySaveCommand,
  ProjectMemoryUpdateCommand,
  ProjectMemoryDeleteCommand,
  ProjectWorkflowCreateCommand,
  ProjectWorkflowDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadAutoSettleCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadPinsReplaceCommand,
  ThreadLegacyPinsImportCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnSteerCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadRewindDraftResolveCommand,
  ThreadSessionStopCommand,
  ThreadCompactRequestCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ProjectMemorySaveCommand,
  ProjectMemoryUpdateCommand,
  ProjectMemoryDeleteCommand,
  ProjectWorkflowCreateCommand,
  ProjectWorkflowDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadAutoSettleCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadPinsReplaceCommand,
  ThreadLegacyPinsImportCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  Schema.Struct({
    ...ClientThreadTurnStartCommand.fields,
    type: Schema.Literal("thread.turn.steer"),
    expectedTurnId: TurnId,
    expectedSessionGeneration: Schema.optional(NonNegativeInt),
  }),
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  Schema.Struct({
    ...ThreadUserInputRespondCommand.fields,
    attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
  }),
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadConversationRevertCommand,
  ThreadRewindDraftResolveCommand,
  ThreadSessionStopCommand,
  ThreadCompactRequestCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

export const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  settledTurnId: Schema.optional(TurnId),
  usageFact: Schema.optional(UsageTurnFact),
  /**
   * Re-binds the session the thread already runs. The decider keeps the turn
   * the current state still has running, so a refresh mid-turn does not drop it.
   */
  rebindLiveSession: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

export const ThreadUsageRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.usage.record"),
  commandId: CommandId,
  threadId: ThreadId,
  usageFact: UsageTurnFact,
  createdAt: IsoDateTime,
});

export const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  // Mirrors `delta -> text` promotion on `thread.message-sent`.
  reasoningDelta: Schema.optional(Schema.String),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

// Internal verified-history repair. Live deltas never reopen a completed message.
export const ThreadMessageAssistantReconcileCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.reconcile"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: TurnId,
  expectedText: Schema.NullOr(Schema.String),
  expectedReasoningText: Schema.String,
  text: Schema.String,
  reasoningText: Schema.String,
  createdAt: IsoDateTime,
});

export const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

// Native moderation is authoritative even after a later turn has started.
export const ThreadMessageAssistantModerateCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.moderate"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  text: Schema.String,
  clearReasoning: Schema.Boolean,
  reasoningSuffix: Schema.String,
  createdAt: IsoDateTime,
});

// Metadata only, so it also applies to completed messages.
export const ThreadMessageReasoningTokensAddCommand = Schema.Struct({
  type: Schema.Literal("thread.message.reasoning-tokens.add"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: TurnId,
  tokens: NonNegativeInt,
  estimated: Schema.Boolean,
  createdAt: IsoDateTime,
});

export const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

export const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadTurnProcessingQuiesceCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.processing.quiesce"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  processingQuiescedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

export const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

export const ThreadTasksUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.tasks.update"),
  commandId: CommandId,
  threadId: ThreadId,
  tasks: Schema.Array(TaskItem),
  turnId: Schema.optional(TurnId),
  /**
   * Omitted: tracking unchanged. Present: replaces it atomically. `null` clears
   * native tracking when a TodoWrite snapshot takes over the task list.
   */
  tracking: Schema.optional(Schema.NullOr(ThreadTaskTracking)),
  /**
   * Generation the update was computed from. The decider rejects the command
   * when a revert advanced the thread's generation in the meantime.
   */
  expectedTrackingGeneration: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

export const ThreadCompactedRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.compacted.record"),
  commandId: CommandId,
  threadId: ThreadId,
  compaction: ThreadCompaction,
  freshSessionGuard: Schema.optional(
    Schema.Struct({
      workflowId: PlanningWorkflowId,
      attempt: NonNegativeInt,
      requestId: CommandId,
      dispatchCommandId: CommandId,
      lastInteractionAt: IsoDateTime,
      branch: Schema.NullOr(TrimmedNonEmptyString),
      worktreePath: Schema.NullOr(FilesystemPath),
      workspaceRoot: FilesystemPath,
      model: TrimmedNonEmptyString,
      binding: Schema.NullOr(
        Schema.Struct({
          provider: ProviderKind,
          instanceId: ProviderInstanceId,
          generation: NonNegativeInt,
        }),
      ),
    }),
  ),
  createdAt: IsoDateTime,
});

export const ThreadSessionNotesRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.session-notes.record"),
  commandId: CommandId,
  threadId: ThreadId,
  sessionNotes: ThreadSessionNotes,
  createdAt: IsoDateTime,
});

// Only an owned provider session can reconcile an already-observed native rewind.
export const ThreadNativeHistoryReconcileCommand = Schema.Struct({
  type: Schema.Literal("thread.native-history.reconcile"),
  commandId: CommandId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  expectedTurnId: TurnId,
  removedTurnIds: Schema.Array(TurnId).check(Schema.isMaxLength(500)),
  createdAt: IsoDateTime,
});

export const ThreadRevertCompleteCommand = Schema.Struct({
  retainedMessageIds: Schema.optional(Schema.Array(MessageId)),
  retainedTurnIds: Schema.optional(Schema.Array(TurnId)),
  operationId: Schema.optional(CommandId),
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadTitleGenerationStartCommand = Schema.Struct({
  type: Schema.Literal("thread.title.generation.start"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedTitleRevision: NonNegativeInt,
  trigger: Schema.optional(Schema.Literal("auto-refine")),
  refinementTurn: Schema.optional(NonNegativeInt),
  titleSourceText: Schema.optional(Schema.String),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  titleGenerationModelSelection: Schema.optional(ModelSelection),
  createdAt: IsoDateTime,
});

export const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  expectedTitleRevision: NonNegativeInt,
  title: TrimmedNonEmptyString,
  needsRefinement: Schema.optional(Schema.Boolean),
  refinementTurn: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

export const ThreadTitleRegenerationFailCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.fail"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  expectedTitleRevision: NonNegativeInt,
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  createdAt: IsoDateTime,
});

export const ThreadCommandExecutionRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.command-execution.record"),
  commandId: CommandId,
  threadId: ThreadId,
  commandExecution: CommandExecutionRecordWithoutThread,
  createdAt: IsoDateTime,
});

export const ThreadCommandExecutionOutputAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.command-execution.output.append"),
  commandId: CommandId,
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
  chunk: Schema.String,
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

/**
 * Replaces a command's projected output with output verified against provider
 * history. Applies only while the row's last update is still
 * `expectedLastUpdatedSequence`, so newer streamed output always wins.
 */
export const ThreadCommandExecutionOutputReconcileCommand = Schema.Struct({
  type: Schema.Literal("thread.command-execution.output.reconcile"),
  commandId: CommandId,
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
  expectedLastUpdatedSequence: NonNegativeInt,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

export const ThreadFileChangeRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.file-change.record"),
  commandId: CommandId,
  threadId: ThreadId,
  fileChange: Schema.Struct({
    ...FileChangeRecordWithoutThread.fields,
    patch: Schema.String,
  }),
  createdAt: IsoDateTime,
});

export const ProjectWorkflowUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.upsert"),
  commandId: CommandId,
  projectId: ProjectId,
  workflow: PlanningWorkflow,
  createdAt: IsoDateTime,
});

/** Server-only: creates the profile's scratch project. Clients call `projects.ensureScratch`. */
export const ProjectScratchCreateCommand = Schema.Struct({
  type: Schema.Literal("project.scratch.create"),
  commandId: CommandId,
  projectId: ProjectId,
  workspaceRoot: FilesystemPath,
  createdAt: IsoDateTime,
});

export const InternalOrchestrationCommand = Schema.Union([
  Schema.Struct({
    ...ThreadCreateCommand.fields,
    type: Schema.Literal("thread.import"),
    expectedWorkspaceRoot: FilesystemPath,
    messages: ImportedSessionMessages,
  }),
  ProjectScratchCreateCommand,
  Schema.Struct({
    type: Schema.Literals(["project.workflow.archive", "project.workflow.unarchive"]),
    commandId: CommandId,
    projectId: ProjectId,
    workflowKind: Schema.Literals(["planning", "codeReview", "investigation"]),
    workflowId: Schema.Union([PlanningWorkflowId, CodeReviewWorkflowId, InvestigationWorkflowId]),
    createdAt: IsoDateTime,
  }),
  ProjectSkillsReplaceCommand,
  ProjectWorkflowUpsertCommand,
  ProjectCodeReviewWorkflowCreateCommand,
  ProjectCodeReviewWorkflowUpsertCommand,
  ProjectCodeReviewWorkflowDeleteCommand,
  ProjectInvestigationWorkflowCreateCommand,
  ProjectInvestigationWorkflowUpsertCommand,
  ProjectInvestigationWorkflowDeleteCommand,
  ThreadSessionSetCommand,
  ThreadUsageRecordCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadMessageAssistantReconcileCommand,
  ThreadMessageAssistantModerateCommand,
  ThreadMessageReasoningTokensAddCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadTurnProcessingQuiesceCommand,
  ThreadActivityAppendCommand,
  ThreadTasksUpdateCommand,
  ThreadCompactedRecordCommand,
  ThreadSessionNotesRecordCommand,
  ThreadRevertCompleteCommand,
  ThreadNativeHistoryReconcileCommand,
  ThreadTitleGenerationStartCommand,
  ThreadTitleRegenerationCompleteCommand,
  ThreadTitleRegenerationFailCommand,
  ThreadCommandExecutionRecordCommand,
  ThreadCommandExecutionOutputAppendCommand,
  ThreadCommandExecutionOutputReconcileCommand,
  ThreadFileChangeRecordCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;
