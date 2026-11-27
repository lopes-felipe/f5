import { OrchestrationProposedPlan } from "../proposedPlan";
import { FilesystemPath } from "../baseSchemas";
import { ThreadSearchInput, ThreadSearchResult } from "../threadSearch";
import {
  PlanningWorkflowSummary,
  CodeReviewWorkflowSummary,
  InvestigationWorkflowSummary,
} from "../workflowSummary";
import { Option, Schema, SchemaIssue, Struct } from "effect";
import { CodeReviewWorkflowId } from "../codeReviewWorkflow";
import { InvestigationWorkflowId } from "../investigationWorkflow";
import { ProviderModelOptions } from "../model";
import {
  DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS,
  DocumentReaderPersona,
  WorkflowDocumentType,
  PlanningWorkflowId,
  WorkflowModelSlot,
  AdditionalWorkflowModelSlots,
} from "../planningWorkflow";
import { CODE_REVIEW_PROMPT_MAX_CHARS } from "../workflowParticipants";
import { ProviderStartOptions } from "../providerStartOptions";
import {
  CheckpointRef,
  EventId,
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
  RuntimeMode,
  DEFAULT_RUNTIME_MODE,
  ProviderApprovalDecision,
  OrchestrationMessage,
  TaskItem,
  ThreadTaskTracking,
  ThreadReference,
  ThreadSessionNotes,
  OrchestrationCommandExecutionId,
  OrchestrationCommandExecution,
  OrchestrationCommandExecutionSummary,
  OrchestrationFileChangeId,
  OrchestrationFileChangeSummary,
  OrchestrationFileChange,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationCheckpointSummary,
  OrchestrationThreadActivity,
  RewindDraft,
  OrchestrationThread,
  OrchestrationReadModel,
} from "./readModel";
import { ClientOrchestrationCommand } from "./commands";
import { OrchestrationEvent } from "./events";

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

export const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

export const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
export const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetStartupSnapshotInput = Schema.Struct({
  detailThreadId: Schema.optional(ThreadId),
});
export type OrchestrationGetStartupSnapshotInput = typeof OrchestrationGetStartupSnapshotInput.Type;

export const OrchestrationGetThreadDetailsInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetThreadDetailsInput = typeof OrchestrationGetThreadDetailsInput.Type;

export const OrchestrationMessageCursor = Schema.Struct({
  createdAt: IsoDateTime,
  messageId: MessageId,
});
export type OrchestrationMessageCursor = typeof OrchestrationMessageCursor.Type;

export const OrchestrationCommandExecutionCursor = Schema.Struct({
  startedAt: IsoDateTime,
  startedSequence: NonNegativeInt,
  commandExecutionId: OrchestrationCommandExecutionId,
});
export type OrchestrationCommandExecutionCursor = typeof OrchestrationCommandExecutionCursor.Type;

export const OrchestrationThreadActivityCursor = Schema.Struct({
  sequenceIsNull: Schema.Boolean,
  sequence: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  activityId: EventId,
}).check(
  Schema.makeFilter(
    (input) =>
      input.sequenceIsNull === (input.sequence === null) ||
      "sequenceIsNull must match whether sequence is null",
  ),
);
export type OrchestrationThreadActivityCursor = typeof OrchestrationThreadActivityCursor.Type;

export const OrchestrationThreadDetails = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  tasks: Schema.Array(TaskItem).pipe(Schema.withDecodingDefault(() => [])),
  tasksTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  tasksUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  tasksTracking: Schema.optional(Schema.NullOr(ThreadTaskTracking)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sessionNotes: Schema.NullOr(ThreadSessionNotes).pipe(Schema.withDecodingDefault(() => null)),
  threadReferences: Schema.Array(ThreadReference).pipe(Schema.withDecodingDefault(() => [])),
  detailSequence: NonNegativeInt,
});
export type OrchestrationThreadDetails = typeof OrchestrationThreadDetails.Type;

/**
 * A thread's unresolved rewind drafts. They live outside the event-sourced read
 * model, so `getSnapshot` (the in-memory model) never carries them.
 */
export const OrchestrationGetRewindDraftsInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetRewindDraftsInput = typeof OrchestrationGetRewindDraftsInput.Type;
export const OrchestrationGetRewindDraftsResult = Schema.Struct({
  threadId: ThreadId,
  drafts: Schema.Array(RewindDraft),
});
export type OrchestrationGetRewindDraftsResult = typeof OrchestrationGetRewindDraftsResult.Type;

/** Max length of `OrchestrationThreadPeek.lastUserText`. */
export const THREAD_PEEK_USER_TEXT_MAX_CHARS = 200;
/** Max length of `OrchestrationThreadPeek.lastAssistantText`. */
export const THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS = 600;

/**
 * One thread's peek. The thread is not looked up: an unknown or deleted id is answered with
 * a peek whose fields are all null, where `getThreadPeeks` leaves that id out.
 */
export const OrchestrationGetThreadPeekInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetThreadPeekInput = typeof OrchestrationGetThreadPeekInput.Type;
/**
 * What the sidebar's hover card shows for a thread whose messages are not loaded: the
 * last prompt, the latest completed turn's reply, and the latest checkpoint's diff totals.
 * Texts are truncated server-side.
 */
export const OrchestrationThreadPeek = Schema.Struct({
  threadId: ThreadId,
  lastUserText: Schema.NullOr(Schema.String),
  lastAssistantText: Schema.NullOr(Schema.String),
  latestTurnDiff: Schema.NullOr(
    Schema.Struct({
      files: NonNegativeInt,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
});
export type OrchestrationThreadPeek = typeof OrchestrationThreadPeek.Type;

/** Most threads one `getThreadPeeks` request may ask for. */
export const THREAD_PEEKS_MAX_THREADS = 50;

export const OrchestrationGetThreadPeeksInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_PEEKS_MAX_THREADS)),
});
export type OrchestrationGetThreadPeeksInput = typeof OrchestrationGetThreadPeeksInput.Type;

/** Peeks in the order asked, each thread once; ids of threads that do not exist are left out. */
export const OrchestrationThreadPeeks = Schema.Struct({
  peeks: Schema.Array(OrchestrationThreadPeek),
});
export type OrchestrationThreadPeeks = typeof OrchestrationThreadPeeks.Type;

export const OrchestrationGetThreadTailDetailsInput = Schema.Struct({
  threadId: ThreadId,
  messageLimit: Schema.optional(NonNegativeInt),
  checkpointLimit: Schema.optional(NonNegativeInt),
  activityLimit: Schema.optional(NonNegativeInt),
});
export type OrchestrationGetThreadTailDetailsInput =
  typeof OrchestrationGetThreadTailDetailsInput.Type;

export const OrchestrationThreadTailDetails = Schema.Struct({
  threadId: ThreadId,
  /** Route fallback when the shell has not listed this thread yet. Null confirms absence. */
  thread: Schema.optional(Schema.NullOr(OrchestrationThread)),
  messages: Schema.Array(OrchestrationMessage),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  activities: Schema.Array(OrchestrationThreadActivity).pipe(Schema.withDecodingDefault(() => [])),
  commandExecutions: Schema.Array(OrchestrationCommandExecutionSummary).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  /** Every plan of the thread, uncapped: replaces the client's plans, including ones a startup snapshot omitted. */
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  tasks: Schema.Array(TaskItem).pipe(Schema.withDecodingDefault(() => [])),
  tasksTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  tasksUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  tasksTracking: Schema.optional(Schema.NullOr(ThreadTaskTracking)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sessionNotes: Schema.NullOr(ThreadSessionNotes).pipe(Schema.withDecodingDefault(() => null)),
  threadReferences: Schema.Array(ThreadReference).pipe(Schema.withDecodingDefault(() => [])),
  hasOlderMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderCheckpoints: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderActivities: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderCommandExecutions: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  oldestLoadedMessageCursor: Schema.NullOr(OrchestrationMessageCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedActivityCursor: Schema.NullOr(OrchestrationThreadActivityCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedCommandExecutionCursor: Schema.NullOr(OrchestrationCommandExecutionCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  detailSequence: NonNegativeInt,
});
export type OrchestrationThreadTailDetails = typeof OrchestrationThreadTailDetails.Type;

export const OrchestrationGetThreadHistoryPageInput = Schema.Struct({
  threadId: ThreadId,
  anchorMessageId: Schema.optional(Schema.NullOr(MessageId)),
  anchorActivityId: Schema.optional(Schema.NullOr(EventId)),
  beforeMessageCursor: Schema.NullOr(OrchestrationMessageCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  afterMessageCursor: Schema.optional(Schema.NullOr(OrchestrationMessageCursor)),
  afterActivityCursor: Schema.optional(Schema.NullOr(OrchestrationThreadActivityCursor)),
  beforeCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  beforeCommandExecutionCursor: Schema.NullOr(OrchestrationCommandExecutionCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  activityCursor: Schema.NullOr(OrchestrationThreadActivityCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  messageLimit: Schema.optional(NonNegativeInt),
  checkpointLimit: Schema.optional(NonNegativeInt),
  activityLimit: Schema.optional(NonNegativeInt),
  commandExecutionLimit: Schema.optional(NonNegativeInt),
}).check(
  Schema.makeFilter((input) => {
    const messageWindowSelectors = [
      input.anchorMessageId,
      input.anchorActivityId,
      input.beforeMessageCursor,
      input.afterMessageCursor,
    ].filter((value) => value != null).length;
    return messageWindowSelectors <= 1 || "Select only one message-history cursor or anchor";
  }),
);
export type OrchestrationGetThreadHistoryPageInput =
  typeof OrchestrationGetThreadHistoryPageInput.Type;

export const OrchestrationThreadHistoryPage = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  activities: Schema.Array(OrchestrationThreadActivity).pipe(Schema.withDecodingDefault(() => [])),
  commandExecutions: Schema.Array(OrchestrationCommandExecutionSummary).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  hasOlderMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasNewerMessages: Schema.optional(Schema.Boolean),
  hasOlderCheckpoints: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderActivities: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasNewerActivities: Schema.optional(Schema.Boolean),
  hasOlderCommandExecutions: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  oldestLoadedMessageCursor: Schema.NullOr(OrchestrationMessageCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  newestLoadedMessageCursor: Schema.optional(Schema.NullOr(OrchestrationMessageCursor)),
  oldestLoadedCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedActivityCursor: Schema.NullOr(OrchestrationThreadActivityCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  newestLoadedActivityCursor: Schema.optional(Schema.NullOr(OrchestrationThreadActivityCursor)),
  oldestLoadedCommandExecutionCursor: Schema.NullOr(OrchestrationCommandExecutionCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  detailSequence: NonNegativeInt,
});
export type OrchestrationThreadHistoryPage = typeof OrchestrationThreadHistoryPage.Type;

export const OrchestrationStartupSnapshot = Schema.Struct({
  ...OrchestrationReadModel.fields,
  planningWorkflows: Schema.Array(PlanningWorkflowSummary),
  codeReviewWorkflows: Schema.Array(CodeReviewWorkflowSummary),
  investigationWorkflows: Schema.Array(InvestigationWorkflowSummary),
});
export type OrchestrationStartupSnapshot = typeof OrchestrationStartupSnapshot.Type;
export const OrchestrationGetStartupSnapshotResult = Schema.Struct({
  snapshot: OrchestrationStartupSnapshot,
  threadTailDetails: Schema.NullOr(OrchestrationThreadTailDetails).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type OrchestrationGetStartupSnapshotResult =
  typeof OrchestrationGetStartupSnapshotResult.Type;

export const OrchestrationGetThreadDetailsResult = OrchestrationThreadDetails;
export type OrchestrationGetThreadDetailsResult = typeof OrchestrationGetThreadDetailsResult.Type;

export const DiffOptions = Schema.Struct({
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId, options: Schema.optionalKey(DiffOptions) }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  options: Schema.optionalKey(DiffOptions),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationGetThreadCommandExecutionsInput = Schema.Struct({
  threadId: ThreadId,
  afterSequenceExclusive: Schema.optional(NonNegativeInt),
});
export type OrchestrationGetThreadCommandExecutionsInput =
  typeof OrchestrationGetThreadCommandExecutionsInput.Type;

export const OrchestrationGetThreadCommandExecutionsResult = Schema.Struct({
  threadId: ThreadId,
  executions: Schema.Array(OrchestrationCommandExecutionSummary),
  latestSequence: NonNegativeInt,
  isFullSync: Schema.Boolean,
});
export type OrchestrationGetThreadCommandExecutionsResult =
  typeof OrchestrationGetThreadCommandExecutionsResult.Type;

export const OrchestrationGetThreadCommandExecutionInput = Schema.Struct({
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
});
export type OrchestrationGetThreadCommandExecutionInput =
  typeof OrchestrationGetThreadCommandExecutionInput.Type;

export const OrchestrationGetThreadCommandExecutionResult = Schema.Struct({
  commandExecution: Schema.NullOr(OrchestrationCommandExecution),
});
export type OrchestrationGetThreadCommandExecutionResult =
  typeof OrchestrationGetThreadCommandExecutionResult.Type;

export const OrchestrationGetThreadFileChangesInput = Schema.Struct({
  threadId: ThreadId,
  afterSequenceExclusive: Schema.optional(NonNegativeInt),
});
export type OrchestrationGetThreadFileChangesInput =
  typeof OrchestrationGetThreadFileChangesInput.Type;

export const OrchestrationGetThreadFileChangesResult = Schema.Struct({
  threadId: ThreadId,
  fileChanges: Schema.Array(OrchestrationFileChangeSummary),
  latestSequence: NonNegativeInt,
  isFullSync: Schema.Boolean,
});
export type OrchestrationGetThreadFileChangesResult =
  typeof OrchestrationGetThreadFileChangesResult.Type;

export const OrchestrationGetThreadFileChangeInput = Schema.Struct({
  threadId: ThreadId,
  fileChangeId: OrchestrationFileChangeId,
});
export type OrchestrationGetThreadFileChangeInput =
  typeof OrchestrationGetThreadFileChangeInput.Type;

export const OrchestrationGetThreadFileChangeResult = Schema.Struct({
  fileChange: Schema.NullOr(OrchestrationFileChange),
});
export type OrchestrationGetThreadFileChangeResult =
  typeof OrchestrationGetThreadFileChangeResult.Type;

export const PlanningWorkflowCreateFields = {
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  requirementPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(80_000)),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  branchA: WorkflowModelSlot,
  branchB: WorkflowModelSlot,
  /** Authors beyond A and B, in roster order. */
  additionalBranches: Schema.optional(AdditionalWorkflowModelSlots),
  merge: WorkflowModelSlot,
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
};
export const OrchestrationCreateWorkflowInput = Schema.Struct({
  ...PlanningWorkflowCreateFields,
  templateId: Schema.optional(TrimmedNonEmptyString),
  templateVersion: Schema.optional(Schema.Int),
  plansDirectory: Schema.optional(FilesystemPath),
  documentType: Schema.optional(WorkflowDocumentType),
});
export type OrchestrationCreateWorkflowInput = typeof OrchestrationCreateWorkflowInput.Type;
export const OrchestrationCreateDocumentWorkflowInput = Schema.Struct({
  ...PlanningWorkflowCreateFields,
  requirementPrompt: TrimmedNonEmptyString.check(
    Schema.isMaxLength(DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS),
  ),
  documentType: WorkflowDocumentType,
  readerReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  readerPersona: Schema.optional(DocumentReaderPersona),
  reader: Schema.optional(WorkflowModelSlot),
});
export type OrchestrationCreateDocumentWorkflowInput =
  typeof OrchestrationCreateDocumentWorkflowInput.Type;
export const OrchestrationSkipDocumentReaderPassInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
});
export type OrchestrationSkipDocumentReaderPassInput =
  typeof OrchestrationSkipDocumentReaderPassInput.Type;
export const OrchestrationSkipDocumentReaderPassResult = Schema.Struct({
  status: Schema.Literal("completed"),
});
export type OrchestrationSkipDocumentReaderPassResult =
  typeof OrchestrationSkipDocumentReaderPassResult.Type;

export const OrchestrationCreateWorkflowResult = Schema.Struct({
  workflowId: PlanningWorkflowId,
});
export type OrchestrationCreateWorkflowResult = typeof OrchestrationCreateWorkflowResult.Type;

export const OrchestrationCreateCodeReviewWorkflowInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  reviewPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(CODE_REVIEW_PROMPT_MAX_CHARS)),
  templateId: Schema.optional(TrimmedNonEmptyString),
  templateVersion: Schema.optional(Schema.Int),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  reviewerA: WorkflowModelSlot,
  reviewerB: WorkflowModelSlot,
  /** Reviewers beyond A and B, in roster order. */
  additionalReviewers: Schema.optional(AdditionalWorkflowModelSlots),
  consolidation: WorkflowModelSlot,
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Post the merged review to the detected GitHub pull request when it finishes. */
  autoPost: Schema.optional(Schema.Boolean),
});
export type OrchestrationCreateCodeReviewWorkflowInput =
  typeof OrchestrationCreateCodeReviewWorkflowInput.Type;

export const OrchestrationCreateCodeReviewWorkflowResult = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
});
export type OrchestrationCreateCodeReviewWorkflowResult =
  typeof OrchestrationCreateCodeReviewWorkflowResult.Type;

export const OrchestrationCreateInvestigationWorkflowInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  problemPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(80_000)),
  templateId: Schema.optional(TrimmedNonEmptyString),
  templateVersion: Schema.optional(Schema.Int),
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  selfReviewEnabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  investigatorA: WorkflowModelSlot,
  investigatorB: WorkflowModelSlot,
  /** Investigators beyond A and B, in roster order. */
  additionalInvestigators: Schema.optional(AdditionalWorkflowModelSlots),
  synthesis: WorkflowModelSlot,
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type OrchestrationCreateInvestigationWorkflowInput =
  typeof OrchestrationCreateInvestigationWorkflowInput.Type;

export const OrchestrationCreateInvestigationWorkflowResult = Schema.Struct({
  workflowId: InvestigationWorkflowId,
});
export type OrchestrationCreateInvestigationWorkflowResult =
  typeof OrchestrationCreateInvestigationWorkflowResult.Type;

export const OrchestrationDeleteWorkflowInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
  deleteThreads: Schema.optional(Schema.Boolean),
});
export type OrchestrationDeleteWorkflowInput = typeof OrchestrationDeleteWorkflowInput.Type;

export const OrchestrationDeleteWorkflowResult = Schema.Union([
  Schema.Struct({ deletedThreadIds: Schema.Array(ThreadId) }),
  Schema.Void,
]);
export type OrchestrationDeleteWorkflowResult = typeof OrchestrationDeleteWorkflowResult.Type;

export const OrchestrationArchiveWorkflowInput = OrchestrationDeleteWorkflowInput;
export type OrchestrationArchiveWorkflowInput = typeof OrchestrationArchiveWorkflowInput.Type;

export const OrchestrationUnarchiveWorkflowInput = OrchestrationDeleteWorkflowInput;
export type OrchestrationUnarchiveWorkflowInput = typeof OrchestrationUnarchiveWorkflowInput.Type;

export const OrchestrationDeleteCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
  deleteThreads: Schema.optional(Schema.Boolean),
});
export type OrchestrationDeleteCodeReviewWorkflowInput =
  typeof OrchestrationDeleteCodeReviewWorkflowInput.Type;

export const OrchestrationArchiveCodeReviewWorkflowInput =
  OrchestrationDeleteCodeReviewWorkflowInput;
export type OrchestrationArchiveCodeReviewWorkflowInput =
  typeof OrchestrationArchiveCodeReviewWorkflowInput.Type;

export const OrchestrationUnarchiveCodeReviewWorkflowInput =
  OrchestrationDeleteCodeReviewWorkflowInput;
export type OrchestrationUnarchiveCodeReviewWorkflowInput =
  typeof OrchestrationUnarchiveCodeReviewWorkflowInput.Type;

export const OrchestrationDeleteInvestigationWorkflowInput = Schema.Struct({
  workflowId: InvestigationWorkflowId,
  deleteThreads: Schema.optional(Schema.Boolean),
});
export type OrchestrationDeleteInvestigationWorkflowInput =
  typeof OrchestrationDeleteInvestigationWorkflowInput.Type;

export const OrchestrationArchiveInvestigationWorkflowInput =
  OrchestrationDeleteInvestigationWorkflowInput;
export type OrchestrationArchiveInvestigationWorkflowInput =
  typeof OrchestrationArchiveInvestigationWorkflowInput.Type;

export const OrchestrationUnarchiveInvestigationWorkflowInput =
  OrchestrationDeleteInvestigationWorkflowInput;
export type OrchestrationUnarchiveInvestigationWorkflowInput =
  typeof OrchestrationUnarchiveInvestigationWorkflowInput.Type;

export const OrchestrationRetryWorkflowInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
  allowPossibleDuplicate: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
});
export type OrchestrationRetryWorkflowInput = typeof OrchestrationRetryWorkflowInput.Type;

export const OrchestrationRetryWorkflowResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
  }),
  Schema.Struct({
    status: Schema.Literal("confirmation_required"),
    threadIds: Schema.Array(ThreadId),
  }),
]);
export type OrchestrationRetryWorkflowResult = typeof OrchestrationRetryWorkflowResult.Type;

export const OrchestrationRetryCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
  scope: Schema.optional(Schema.Literals(["failed", "consolidation"])).pipe(
    Schema.withDecodingDefault(() => "failed" as const),
  ),
  allowPossibleDuplicate: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
});
export type OrchestrationRetryCodeReviewWorkflowInput =
  typeof OrchestrationRetryCodeReviewWorkflowInput.Type;

export const OrchestrationPostCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
  /**
   * When an earlier post's outcome is unknown, abandon it and post again
   * instead of re-verifying it. The earlier comment may already be on GitHub.
   */
  allowPossibleDuplicate: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
});
export type OrchestrationPostCodeReviewWorkflowInput =
  typeof OrchestrationPostCodeReviewWorkflowInput.Type;

export const OrchestrationPostCodeReviewWorkflowResult = Schema.Struct({
  status: Schema.Literal("started"),
});
export type OrchestrationPostCodeReviewWorkflowResult =
  typeof OrchestrationPostCodeReviewWorkflowResult.Type;

export const OrchestrationRetryInvestigationWorkflowInput = Schema.Struct({
  workflowId: InvestigationWorkflowId,
  scope: Schema.optional(
    Schema.Literals(["failed", "crossReview", "selfReview", "synthesis"]),
  ).pipe(Schema.withDecodingDefault(() => "failed" as const)),
});
export type OrchestrationRetryInvestigationWorkflowInput =
  typeof OrchestrationRetryInvestigationWorkflowInput.Type;

export const OrchestrationStartImplementationInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  modelOptions: Schema.optional(ProviderModelOptions),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  codeReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  envMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withDecodingDefault(() => "local" as const),
  ),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationStartImplementationInput =
  typeof OrchestrationStartImplementationInput.Type;

export const OrchestrationGetLatestSequenceInput = Schema.Struct({
  resume: Schema.optional(
    Schema.Struct({
      afterSequence: NonNegativeInt,
      backendIncarnation: Schema.String,
    }),
  ),
});
export type OrchestrationGetLatestSequenceInput = typeof OrchestrationGetLatestSequenceInput.Type;

export const OrchestrationGetLatestSequenceResult = Schema.Struct({
  latestSequence: NonNegativeInt,
  backendIncarnation: Schema.String,
  /** Present when the entire requested range can be replayed, including an empty range. */
  events: Schema.optional(Schema.Array(OrchestrationEvent)),
  /** A matched backend could not replay this gap. Read the shell snapshot over HTTP. */
  snapshotRequired: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationGetLatestSequenceResult = typeof OrchestrationGetLatestSequenceResult.Type;

export const orchestrationRpcSchemas = {
  searchThread: { input: ThreadSearchInput, output: ThreadSearchResult },
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  getStartupSnapshot: {
    input: OrchestrationGetStartupSnapshotInput,
    output: OrchestrationGetStartupSnapshotResult,
  },
  getThreadTailDetails: {
    input: OrchestrationGetThreadTailDetailsInput,
    output: OrchestrationThreadTailDetails,
  },
  getRewindDrafts: {
    input: OrchestrationGetRewindDraftsInput,
    output: OrchestrationGetRewindDraftsResult,
  },
  getThreadPeek: {
    input: OrchestrationGetThreadPeekInput,
    output: OrchestrationThreadPeek,
  },
  getThreadPeeks: {
    input: OrchestrationGetThreadPeeksInput,
    output: OrchestrationThreadPeeks,
  },
  getThreadHistoryPage: {
    input: OrchestrationGetThreadHistoryPageInput,
    output: OrchestrationThreadHistoryPage,
  },
  getThreadDetails: {
    input: OrchestrationGetThreadDetailsInput,
    output: OrchestrationGetThreadDetailsResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getThreadCommandExecutions: {
    input: OrchestrationGetThreadCommandExecutionsInput,
    output: OrchestrationGetThreadCommandExecutionsResult,
  },
  getThreadCommandExecution: {
    input: OrchestrationGetThreadCommandExecutionInput,
    output: OrchestrationGetThreadCommandExecutionResult,
  },
  getThreadFileChanges: {
    input: OrchestrationGetThreadFileChangesInput,
    output: OrchestrationGetThreadFileChangesResult,
  },
  getThreadFileChange: {
    input: OrchestrationGetThreadFileChangeInput,
    output: OrchestrationGetThreadFileChangeResult,
  },
  createWorkflow: {
    input: OrchestrationCreateWorkflowInput,
    output: OrchestrationCreateWorkflowResult,
  },
  archiveWorkflow: {
    input: OrchestrationArchiveWorkflowInput,
    output: Schema.Void,
  },
  unarchiveWorkflow: {
    input: OrchestrationUnarchiveWorkflowInput,
    output: Schema.Void,
  },
  createCodeReviewWorkflow: {
    input: OrchestrationCreateCodeReviewWorkflowInput,
    output: OrchestrationCreateCodeReviewWorkflowResult,
  },
  createInvestigationWorkflow: {
    input: OrchestrationCreateInvestigationWorkflowInput,
    output: OrchestrationCreateInvestigationWorkflowResult,
  },
  archiveCodeReviewWorkflow: {
    input: OrchestrationArchiveCodeReviewWorkflowInput,
    output: Schema.Void,
  },
  archiveInvestigationWorkflow: {
    input: OrchestrationArchiveInvestigationWorkflowInput,
    output: Schema.Void,
  },
  unarchiveCodeReviewWorkflow: {
    input: OrchestrationUnarchiveCodeReviewWorkflowInput,
    output: Schema.Void,
  },
  unarchiveInvestigationWorkflow: {
    input: OrchestrationUnarchiveInvestigationWorkflowInput,
    output: Schema.Void,
  },
  deleteWorkflow: {
    input: OrchestrationDeleteWorkflowInput,
    output: OrchestrationDeleteWorkflowResult,
  },
  deleteCodeReviewWorkflow: {
    input: OrchestrationDeleteCodeReviewWorkflowInput,
    output: OrchestrationDeleteWorkflowResult,
  },
  deleteInvestigationWorkflow: {
    input: OrchestrationDeleteInvestigationWorkflowInput,
    output: OrchestrationDeleteWorkflowResult,
  },
  skipDocumentReaderPass: {
    input: OrchestrationSkipDocumentReaderPassInput,
    output: OrchestrationSkipDocumentReaderPassResult,
  },
  retryWorkflow: {
    input: OrchestrationRetryWorkflowInput,
    output: OrchestrationRetryWorkflowResult,
  },
  retryCodeReviewWorkflow: {
    input: OrchestrationRetryCodeReviewWorkflowInput,
    output: OrchestrationRetryWorkflowResult,
  },
  postCodeReviewWorkflow: {
    input: OrchestrationPostCodeReviewWorkflowInput,
    output: OrchestrationPostCodeReviewWorkflowResult,
  },
  retryInvestigationWorkflow: {
    input: OrchestrationRetryInvestigationWorkflowInput,
    output: Schema.Void,
  },
  startImplementation: {
    input: OrchestrationStartImplementationInput,
    output: Schema.Void,
  },
} as const;

// Refer to the replay schema by name rather than expanding its event union
// into the already large declaration for the table.
export const OrchestrationRpcSchemas: typeof orchestrationRpcSchemas & {
  readonly getLatestSequence: {
    readonly input: typeof OrchestrationGetLatestSequenceInput;
    readonly output: typeof OrchestrationGetLatestSequenceResult;
  };
} = {
  ...orchestrationRpcSchemas,
  getLatestSequence: {
    input: OrchestrationGetLatestSequenceInput,
    output: OrchestrationGetLatestSequenceResult,
  },
};
