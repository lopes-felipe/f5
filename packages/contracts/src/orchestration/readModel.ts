import { ScheduledOrigin } from "../baseSchemas";
import { OrchestrationProposedPlanId, OrchestrationProposedPlan } from "../proposedPlan";
import { FilesystemPath } from "../baseSchemas";
import { ProviderRuntimeInfo } from "../runtimeInfo";
import { RuntimeUsageLimit } from "../usageLimit";
import { PendingUserInput } from "../userInput";
import { UploadedAttachmentRef, ATTACHMENT_MAX_FILE_BYTES } from "../attachmentUpload";
import { SourceControlPullRequestRef } from "../sourceControl";
import { Effect, Option, Schema, SchemaIssue, SchemaTransformation, Struct } from "effect";
import { CodeReviewWorkflow } from "../codeReviewWorkflow";
import { InvestigationWorkflow } from "../investigationWorkflow";
import { ProviderOptionSelections } from "../model";
import { PlanningWorkflow } from "../planningWorkflow";
import { ProviderInstanceId } from "../providerInstance";
import { ProviderSessionCapabilities, ProviderExtensionStatuses } from "../sessionCapabilities";
import { ProjectIcon } from "../project";
import { ThreadEnvMode } from "../threadEnvMode";
import {
  isKnownProviderKind as isKnownProviderKindValue,
  ProviderKind as ProviderKindSchema,
} from "../providerKind";
import {
  ComputerStepSummary,
  TOOL_LIFECYCLE_ITEM_TYPES,
  ToolCompletionEnvelope,
} from "../toolLifecycle";
import {
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  makeEntityId,
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

export const ORCHESTRATION_WS_METHODS = {
  searchThread: "threads.search",
  getSnapshot: "orchestration.getSnapshot",
  getLatestSequence: "orchestration.getLatestSequence",
  getStartupSnapshot: "orchestration.getStartupSnapshot",
  getThreadTailDetails: "orchestration.getThreadTailDetails",
  getRewindDrafts: "orchestration.getRewindDrafts",
  getThreadPeek: "orchestration.getThreadPeek",
  getThreadPeeks: "orchestration.getThreadPeeks",
  getThreadHistoryPage: "orchestration.getThreadHistoryPage",
  getThreadDetails: "orchestration.getThreadDetails",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  getThreadCommandExecutions: "orchestration.getThreadCommandExecutions",
  getThreadCommandExecution: "orchestration.getThreadCommandExecution",
  getThreadFileChanges: "orchestration.getThreadFileChanges",
  getThreadFileChange: "orchestration.getThreadFileChange",
  createWorkflow: "orchestration.createWorkflow",
  archiveWorkflow: "orchestration.archiveWorkflow",
  unarchiveWorkflow: "orchestration.unarchiveWorkflow",
  deleteWorkflow: "orchestration.deleteWorkflow",
  retryWorkflow: "orchestration.retryWorkflow",
  skipDocumentReaderPass: "orchestration.skipDocumentReaderPass",
  createCodeReviewWorkflow: "orchestration.createCodeReviewWorkflow",
  archiveCodeReviewWorkflow: "orchestration.archiveCodeReviewWorkflow",
  unarchiveCodeReviewWorkflow: "orchestration.unarchiveCodeReviewWorkflow",
  deleteCodeReviewWorkflow: "orchestration.deleteCodeReviewWorkflow",
  retryCodeReviewWorkflow: "orchestration.retryCodeReviewWorkflow",
  postCodeReviewWorkflow: "orchestration.postCodeReviewWorkflow",
  createInvestigationWorkflow: "orchestration.createInvestigationWorkflow",
  archiveInvestigationWorkflow: "orchestration.archiveInvestigationWorkflow",
  unarchiveInvestigationWorkflow: "orchestration.unarchiveInvestigationWorkflow",
  deleteInvestigationWorkflow: "orchestration.deleteInvestigationWorkflow",
  retryInvestigationWorkflow: "orchestration.retryInvestigationWorkflow",
  startImplementation: "orchestration.startImplementation",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
} as const;

export const ProviderKind = ProviderKindSchema;
export type ProviderKind = typeof ProviderKind.Type;
export const isKnownProviderKind = isKnownProviderKindValue;
export const DEFAULT_NEW_THREAD_TITLE = "New thread";
export const MAX_PINNED_THREADS = 5;
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;
export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

export const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          instanceId: value.instanceId,
          model: value.model,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RUNTIME_MODE_VALUES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export const RuntimeMode = Schema.Literals(RUNTIME_MODE_VALUES);
export type RuntimeMode = typeof RuntimeMode.Type;
export const isRuntimeMode = Schema.is(RuntimeMode);
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const WorkflowTurnExecutionProfile = Schema.Literals([
  "attended-readonly",
  "unattended-readonly",
]);
export type WorkflowTurnExecutionProfile = typeof WorkflowTurnExecutionProfile.Type;
/**
 * How a read-only workflow stage is kept read-only. `sandbox`: the provider runs commands in an
 * OS sandbox that cannot write the workspace or reach the network. `policy`: F5 or the provider
 * decides each operation (plan mode, F5's command allowlist). `f5-sandbox` is reserved for an
 * F5-owned wrapper around the provider process; nothing resolves to it yet.
 */
export const ReadOnlyEnforcement = Schema.Literals(["sandbox", "policy", "f5-sandbox"]);
export type ReadOnlyEnforcement = typeof ReadOnlyEnforcement.Type;
export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "permission",
  "mcp-elicitation",
  "unknown",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: Schema.String,
  warning: Schema.optional(Schema.String),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;
/**
 * Provider-authored prompt metadata for an approval. Strings are display-only
 * and untrusted; `defaultToNo` focuses Decline, and `suppressAlwaysAllowRule`
 * hides persistent choices (the server also downgrades them to a plain accept).
 */
export const ProviderApprovalPresentation = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  decisionReason: Schema.optional(Schema.String),
  fullAccessOverride: Schema.optional(Schema.Literals(["ask_rule", "provider_check"])),
  askRuleSource: Schema.optional(Schema.String),
  blockedPath: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  defaultToNo: Schema.optional(Schema.Boolean),
  suppressAlwaysAllowRule: Schema.optional(Schema.Boolean),
});
export type ProviderApprovalPresentation = typeof ProviderApprovalPresentation.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 100;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
export const ProviderTurnInputText = Schema.String.check(
  Schema.makeFilter(
    (input) =>
      input.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS ||
      new SchemaIssue.InvalidValue(Option.some(input.length), {
        message: `Message exceeds the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} character provider input limit.`,
      }),
    { identifier: "ProviderTurnInputText" },
  ),
);
export const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  source: Schema.optional(Schema.Literals(["pasted-text", "snapshot"])),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(ATTACHMENT_MAX_FILE_BYTES)),
  source: Schema.optional(Schema.Literals(["pasted-text", "snapshot"])),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;
export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
export const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadedAttachmentRef,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  worktreeLayout: Schema.optionalKey(Schema.Literals(["create", "remove"])),
  runOnWorktreeSettle: Schema.optional(Schema.Boolean),
  stopOnSettle: Schema.optional(Schema.Boolean),
  /**
   * Whether the agent may start while this setup script still runs. Absent
   * means true, so scripts saved before the option existed keep running in
   * the background.
   */
  async: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectMemoryScope = Schema.Literals(["user", "project"]);
export type ProjectMemoryScope = typeof ProjectMemoryScope.Type;

export const ProjectMemoryType = Schema.Literals(["user", "feedback", "project", "reference"]);
export type ProjectMemoryType = typeof ProjectMemoryType.Type;

export const ProjectMemory = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  scope: ProjectMemoryScope,
  type: ProjectMemoryType,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
});
export type ProjectMemory = typeof ProjectMemory.Type;

export const ProjectSkillScope = Schema.Literals(["project", "user"]);
export type ProjectSkillScope = typeof ProjectSkillScope.Type;

export const ProjectSkillDefinition = Schema.Struct({
  nativeProviders: Schema.optional(Schema.Array(ProviderKind)),
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  scope: ProjectSkillScope,
  commandName: TrimmedNonEmptyString,
  displayName: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  description: TrimmedNonEmptyString,
  argumentHint: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  allowedTools: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  paths: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  updatedAt: IsoDateTime,
});
export const ProjectSkill = ProjectSkillDefinition.mapFields((fields) => ({
  ...fields,
  providerVariants: Schema.optional(Schema.Record(Schema.String, ProjectSkillDefinition)),
}));
export type ProjectSkill = typeof ProjectSkill.Type;

/**
 * `scratch` is the profile's reserved home for threads without a project. Only the server
 * creates it (`project.scratch.create`), and each of its threads runs in its own folder.
 */
export const ProjectKind = Schema.Literals(["standard", "scratch"]);
export type ProjectKind = typeof ProjectKind.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "standard" as const)),
  title: TrimmedNonEmptyString,
  workspaceRoot: FilesystemPath,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  defaultEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  icon: Schema.optional(Schema.NullOr(ProjectIcon)).pipe(Schema.withDecodingDefault(() => null)),
  scripts: Schema.Array(ProjectScript),
  memories: Schema.Array(ProjectMemory).pipe(Schema.withDecodingDefault(() => [])),
  skills: Schema.optional(Schema.Array(ProjectSkill)).pipe(Schema.withDecodingDefault(() => [])),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const UserMessageSkillCall = Schema.Struct({
  // Produced by normalizeHostCompatibleRuntimeSlashCommandName in @t3tools/shared/slashCommands.
  // The message text may use provider-native slash form or Codex dollar form.
  name: TrimmedNonEmptyString,
});
export type UserMessageSkillCall = typeof UserMessageSkillCall.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  /** Server-owned submission provenance; missing historical stamps remain possibly human. */
  authorship: Schema.optional(Schema.Literals(["human", "automation"])),
  reasoningText: Schema.optional(Schema.String),
  /** Reasoning tokens attributed to this assistant message. */
  reasoningTokens: Schema.optional(NonNegativeInt),
  /** True when any part of `reasoningTokens` is a provider estimate. */
  reasoningTokensEstimated: Schema.optional(Schema.Boolean),
  skillCall: Schema.optional(UserMessageSkillCall),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export { OrchestrationProposedPlanId, OrchestrationProposedPlan } from "../proposedPlan";
export const TaskItemStatus = Schema.Literals(["pending", "in_progress", "completed"]);
export type TaskItemStatus = typeof TaskItemStatus.Type;

export const TaskItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
  activeForm: TrimmedNonEmptyString,
  status: TaskItemStatus,
  // Native Task tools (Claude TaskCreate/TaskUpdate/TaskList/TaskGet) only.
  description: Schema.optional(Schema.String),
  owner: Schema.optional(TrimmedNonEmptyString),
  blocks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  blockedBy: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type TaskItem = typeof TaskItem.Type;

export const MAX_THREAD_TASKS = 512;
export const MAX_TASK_TOOL_PENDING_CALLS = 64;
export const MAX_TASK_TOOL_HANDLED_CALL_IDS = 256;

/**
 * `synced`: the projection matches every result F5 observed. `sync-required`:
 * F5 saw a result it could not reconcile (unknown id, missing call, revert);
 * the next native TaskList restores it. `overflow`: a bound was exceeded and
 * the last valid snapshot is kept.
 */
export const TaskToolSyncState = Schema.Literals(["synced", "sync-required", "overflow"]);
export type TaskToolSyncState = typeof TaskToolSyncState.Type;

export const TaskToolPendingCall = Schema.Struct({
  nativeCallId: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  generation: NonNegativeInt,
  turnId: Schema.NullOr(TurnId),
});
export type TaskToolPendingCall = typeof TaskToolPendingCall.Type;

/** Which call (and turn) created a task, so revert can suppress discarded tasks. */
export const TaskToolProvenance = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  nativeCallId: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
});
export type TaskToolProvenance = typeof TaskToolProvenance.Type;

/**
 * Bounded correlation state for native Task tools, persisted with the task
 * snapshot (no separate event family). The harness owns execution; F5 owns
 * this projection. `generation` increases on revert and checkpoint restore so
 * results from discarded work are never applied.
 */
export const ThreadTaskTracking = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Literal("claude-task-tools"),
  nativeSessionId: Schema.NullOr(TrimmedNonEmptyString),
  generation: NonNegativeInt,
  syncState: TaskToolSyncState,
  syncDetail: Schema.optional(Schema.String),
  pendingCalls: Schema.Array(TaskToolPendingCall),
  invalidatedCallIds: Schema.Array(TrimmedNonEmptyString),
  handledCallIds: Schema.Array(TrimmedNonEmptyString),
  provenance: Schema.Array(TaskToolProvenance),
  suppressedTaskIds: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadTaskTracking = typeof ThreadTaskTracking.Type;

export const ThreadCompactionDirection = Schema.Literals(["from", "up_to"]);
export type ThreadCompactionDirection = typeof ThreadCompactionDirection.Type;

export const ThreadCompactionTrigger = Schema.Literals(["manual", "automatic"]);
export type ThreadCompactionTrigger = typeof ThreadCompactionTrigger.Type;

export const ThreadCompaction = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["summary", "native"])),
  /** Record that rotated the provider conversation and measured the restored input. */
  freshSessionRecordId: Schema.optional(CommandId),
  retiredSessionGeneration: Schema.optional(NonNegativeInt),
  summary: TrimmedNonEmptyString,
  trigger: ThreadCompactionTrigger,
  estimatedTokens: NonNegativeInt,
  modelContextWindowTokens: NonNegativeInt,
  createdAt: IsoDateTime,
  direction: Schema.NullOr(ThreadCompactionDirection).pipe(Schema.withDecodingDefault(() => null)),
  pivotMessageId: Schema.NullOr(MessageId).pipe(Schema.withDecodingDefault(() => null)),
  fromTurnCount: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(() => null)),
  toTurnCount: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(() => null)),
});
export type ThreadCompaction = typeof ThreadCompaction.Type;

export const ThreadReferenceRelation = Schema.Literals([
  "source",
  "research",
  "synthesis",
  "implementation",
  "verification",
]);
export type ThreadReferenceRelation = typeof ThreadReferenceRelation.Type;

export const ThreadReference = Schema.Struct({
  threadId: ThreadId,
  relation: ThreadReferenceRelation,
  createdAt: IsoDateTime,
});
export type ThreadReference = typeof ThreadReference.Type;

export const ThreadSessionNotes = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  currentState: Schema.String,
  taskSpecification: Schema.String,
  filesAndFunctions: Schema.String,
  workflow: Schema.String,
  errorsAndCorrections: Schema.String,
  codebaseAndSystemDocumentation: Schema.String,
  learnings: Schema.String,
  keyResults: Schema.String,
  worklog: Schema.String,
  updatedAt: IsoDateTime,
  sourceLastInteractionAt: IsoDateTime,
});
export type ThreadSessionNotes = typeof ThreadSessionNotes.Type;

export const OrchestrationCommandExecutionId = makeEntityId("OrchestrationCommandExecutionId");
export type OrchestrationCommandExecutionId = typeof OrchestrationCommandExecutionId.Type;

export const OrchestrationCommandExecutionStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "interrupted",
  "declined",
]);
export type OrchestrationCommandExecutionStatus = typeof OrchestrationCommandExecutionStatus.Type;

export const CommandExecutionRecordFields = {
  id: OrchestrationCommandExecutionId,
  threadId: ThreadId,
  turnId: TurnId,
  providerItemId: Schema.NullOr(ProviderItemId),
  command: TrimmedNonEmptyString,
  cwd: Schema.optional(FilesystemPath),
  /** Provider-authored one-line intent, e.g. Claude's Bash `description`. */
  description: Schema.optional(TrimmedNonEmptyString),
  title: Schema.NullOr(TrimmedNonEmptyString),
  status: OrchestrationCommandExecutionStatus,
  detail: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
} as const;

export const CommandExecutionRecordWithoutThread = Schema.Struct(
  Struct.omit(CommandExecutionRecordFields, ["threadId"]),
);

export const OrchestrationCommandExecution = Schema.Struct({
  ...CommandExecutionRecordFields,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  startedSequence: NonNegativeInt,
  lastUpdatedSequence: NonNegativeInt,
});
export type OrchestrationCommandExecution = typeof OrchestrationCommandExecution.Type;

export const OrchestrationCommandExecutionSummary = Schema.Struct({
  ...CommandExecutionRecordFields,
  startedSequence: NonNegativeInt,
  lastUpdatedSequence: NonNegativeInt,
});
export type OrchestrationCommandExecutionSummary = typeof OrchestrationCommandExecutionSummary.Type;

export const OrchestrationFileChangeId = makeEntityId("OrchestrationFileChangeId");
export type OrchestrationFileChangeId = typeof OrchestrationFileChangeId.Type;

export const OrchestrationFileChangeStatus = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "declined",
]);
export type OrchestrationFileChangeStatus = typeof OrchestrationFileChangeStatus.Type;

export const FileChangeRecordFields = {
  id: OrchestrationFileChangeId,
  threadId: ThreadId,
  turnId: TurnId,
  providerItemId: Schema.NullOr(ProviderItemId),
  title: Schema.NullOr(TrimmedNonEmptyString),
  detail: Schema.NullOr(Schema.String),
  status: OrchestrationFileChangeStatus,
  changedFiles: Schema.Array(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
} as const;

export const FileChangeRecordWithoutThread = Schema.Struct(
  Struct.omit(FileChangeRecordFields, ["threadId"]),
);

export const OrchestrationFileChangeSummary = Schema.Struct({
  ...FileChangeRecordFields,
  startedSequence: NonNegativeInt,
  lastUpdatedSequence: NonNegativeInt,
  hasPatch: Schema.Boolean,
});
export type OrchestrationFileChangeSummary = typeof OrchestrationFileChangeSummary.Type;

export const OrchestrationFileChange = Schema.Struct({
  ...FileChangeRecordFields,
  startedSequence: NonNegativeInt,
  lastUpdatedSequence: NonNegativeInt,
  hasPatch: Schema.Boolean,
  patch: Schema.String,
});
export type OrchestrationFileChange = typeof OrchestrationFileChange.Type;

export const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationUsageLimit = Schema.Struct({
  ...RuntimeUsageLimit.fields,
  providerInstanceId: ProviderInstanceId,
  turnId: Schema.NullOr(TurnId),
  deliveryId: Schema.NullOr(Schema.String),
});
export type OrchestrationUsageLimit = typeof OrchestrationUsageLimit.Type;

/**
 * A turn failed because the provider account's login expired or was rejected.
 * It stays on the session until a new turn starts, so the thread can offer a
 * one-click sign-in and resend the turn that never reached the provider.
 */
export const OrchestrationAuthFailure = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  turnId: Schema.NullOr(TurnId),
  occurredAt: IsoDateTime,
});
export type OrchestrationAuthFailure = typeof OrchestrationAuthFailure.Type;

export const OrchestrationSession = Schema.Struct({
  extensionStatuses: Schema.optional(ProviderExtensionStatuses),
  usageLimit: Schema.optional(Schema.NullOr(OrchestrationUsageLimit)),
  authFailure: Schema.optional(Schema.NullOr(OrchestrationAuthFailure)),
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  workflowExecutionProfile: Schema.optional(WorkflowTurnExecutionProfile),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  lastErrorId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  lastErrorOccurredAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  lastErrorRetryability: Schema.optional(
    Schema.NullOr(Schema.Literals(["retryable", "non-retryable"])),
  ).pipe(Schema.withDecodingDefault(() => null)),
  turnCostUsd: Schema.optional(Schema.Number),
  autoCompactThreshold: Schema.optional(Schema.NullOr(NonNegativeInt)),
  estimatedContextTokens: Schema.optional(NonNegativeInt),
  estimatedThinkingTokens: Schema.optional(NonNegativeInt),
  modelContextWindowTokens: Schema.optional(NonNegativeInt),
  tokenUsageSource: Schema.optional(Schema.Literals(["provider", "estimated"])),
  /**
   * Capabilities of the session generation the thread is bound to. Omitted
   * updates keep the previous snapshot; `null` clears it.
   */
  capabilities: Schema.optional(Schema.NullOr(ProviderSessionCapabilities)),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: FilesystemPath,
  repositoryPath: Schema.optionalKey(FilesystemPath),
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

export const CompactToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);

export const CompactToolActivityStatus = Schema.Literals([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);

export const CodexCollaborationTool = Schema.Literals([
  "spawnAgent",
  "sendInput",
  "resumeAgent",
  "wait",
  "closeAgent",
]);
export type CodexCollaborationTool = typeof CodexCollaborationTool.Type;

export const CodexCollaborationAgentStatus = Schema.Literals([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);
export type CodexCollaborationAgentStatus = typeof CodexCollaborationAgentStatus.Type;

export const CompactSubagentState = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  status: CodexCollaborationAgentStatus,
  message: Schema.optional(Schema.String),
});
export type CompactSubagentState = typeof CompactSubagentState.Type;

export const CompactToolActivityPayload = Schema.Struct({
  computerTool: Schema.optional(Schema.Boolean),
  computerStep: Schema.optional(ComputerStepSummary),
  imagePath: Schema.optional(TrimmedNonEmptyString),
  itemType: CompactToolLifecycleItemType,
  providerItemId: Schema.optional(ProviderItemId),
  status: Schema.optional(CompactToolActivityStatus),
  title: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(Schema.String),
  requestKind: Schema.optional(ProviderRequestKind),
  command: Schema.optional(TrimmedNonEmptyString),
  readPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  lineSummary: Schema.optional(TrimmedNonEmptyString),
  searchSummary: Schema.optional(TrimmedNonEmptyString),
  changedFiles: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  fileChangeId: Schema.optional(OrchestrationFileChangeId),
  subagentType: Schema.optional(TrimmedNonEmptyString),
  subagentDescription: Schema.optional(TrimmedNonEmptyString),
  subagentPrompt: Schema.optional(Schema.String),
  subagentResult: Schema.optional(Schema.String),
  subagentModel: Schema.optional(TrimmedNonEmptyString),
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  subagentThreadId: Schema.optional(TrimmedNonEmptyString),
  subagentPath: Schema.optional(TrimmedNonEmptyString),
  subagentSenderThreadId: Schema.optional(TrimmedNonEmptyString),
  subagentReceiverThreadIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  codexCollaborationTool: Schema.optional(CodexCollaborationTool),
  subagentStates: Schema.optional(Schema.Array(CompactSubagentState)),
  subagentStatesTruncated: Schema.optional(Schema.Boolean),
  mcpServerName: Schema.optional(TrimmedNonEmptyString),
  mcpToolName: Schema.optional(TrimmedNonEmptyString),
  mcpInput: Schema.optional(Schema.String),
  mcpResult: Schema.optional(Schema.String),
  /** Tool-result screenshots stored in the attachment registry; base64 never stays inline. */
  mcpImages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        attachmentId: TrimmedNonEmptyString,
        mimeType: TrimmedNonEmptyString,
        sizeBytes: NonNegativeInt,
      }),
    ),
  ),
  mcpImagesOmitted: Schema.optional(NonNegativeInt),
  /** Typed native result, present only on `tool.completed` activities. */
  completion: Schema.optional(ToolCompletionEnvelope),
});
export type CompactToolActivityPayload = typeof CompactToolActivityPayload.Type;

export const AgentCapabilityState = Schema.Literals([
  "off",
  "pending",
  "connected",
  "failed",
  "unavailable",
]);
export type AgentCapabilityState = typeof AgentCapabilityState.Type;

/** Browser/computer capabilities installed for the latest provider session. */
export const RuntimeAgentBrowserCapabilities = Schema.Struct({
  preview: Schema.optional(
    Schema.Struct({
      serverName: TrimmedNonEmptyString,
      installed: Schema.Boolean,
      /** False once the provider reported the server without F5's exact provenance. */
      verified: Schema.optional(Schema.Boolean),
    }),
  ),
  computer: Schema.optional(
    Schema.Struct({
      serverName: TrimmedNonEmptyString,
      installed: Schema.Boolean,
      verified: Schema.optional(Schema.Boolean),
    }),
  ),
  chrome: Schema.optional(
    Schema.Struct({ state: AgentCapabilityState, detail: Schema.optional(Schema.String) }),
  ),
  computerUse: Schema.optional(
    Schema.Struct({
      state: AgentCapabilityState,
      backend: Schema.optional(Schema.Literals(["claude-builtin", "codex-builtin", "native"])),
      detail: Schema.optional(Schema.String),
    }),
  ),
});
export type RuntimeAgentBrowserCapabilities = typeof RuntimeAgentBrowserCapabilities.Type;

export const CompactRuntimeConfiguredActivityPayload = Schema.Struct({
  runtimeInfo: Schema.optional(ProviderRuntimeInfo),
  model: Schema.optional(TrimmedNonEmptyString),
  claudeCodeVersion: Schema.optional(TrimmedNonEmptyString),
  sessionId: Schema.optional(TrimmedNonEmptyString),
  fastModeState: Schema.optional(TrimmedNonEmptyString),
  fastModeDisabledReason: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  reasoning: Schema.optional(TrimmedNonEmptyString),
  contextWindow: Schema.optional(TrimmedNonEmptyString),
  thinkingState: Schema.optional(TrimmedNonEmptyString),
  outputStyle: Schema.optional(TrimmedNonEmptyString),
  instructionContractVersion: Schema.optional(TrimmedNonEmptyString),
  instructionSupplementVersion: Schema.optional(TrimmedNonEmptyString),
  instructionStrategy: Schema.optional(TrimmedNonEmptyString),
  slashCommands: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        description: TrimmedNonEmptyString,
        argumentHint: Schema.optional(TrimmedNonEmptyString),
      }),
    ),
  ),
  agentBrowser: Schema.optional(RuntimeAgentBrowserCapabilities),
});
export type CompactRuntimeConfiguredActivityPayload =
  typeof CompactRuntimeConfiguredActivityPayload.Type;

export const CompactMcpStatusActivityStatus = Schema.Literals([
  "needs-auth",
  "starting",
  "ready",
  "failed",
  "cancelled",
]);
export type CompactMcpStatusActivityStatus = typeof CompactMcpStatusActivityStatus.Type;

export const CompactMcpStatusActivityPayload = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  status: CompactMcpStatusActivityStatus,
  error: Schema.optional(Schema.String),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  sessionGeneration: Schema.optional(NonNegativeInt),
  toolCount: Schema.optional(NonNegativeInt),
});
export type CompactMcpStatusActivityPayload = typeof CompactMcpStatusActivityPayload.Type;

export const CompactMcpOauthActivityPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(Schema.String),
});
export type CompactMcpOauthActivityPayload = typeof CompactMcpOauthActivityPayload.Type;

export const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  processingQuiescedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  assistantMessageId: Schema.NullOr(MessageId),
  workflowExecutionProfile: Schema.optional(WorkflowTurnExecutionProfile),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleSource = Schema.Literals(["default", "generated", "manual", "legacy"]);
export type ThreadTitleSource = typeof ThreadTitleSource.Type;

export const ThreadTitleState = Schema.Struct({
  needsRefinement: Schema.Boolean,
  refinementCount: NonNegativeInt.check(Schema.isLessThanOrEqualTo(2)),
  lastRefinedTurn: NonNegativeInt,
});
export type ThreadTitleState = typeof ThreadTitleState.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

/**
 * Lifecycle of a conversation rewind, mirrored by the `rewind_operations.state`
 * CHECK constraint. `prepared` is the only state that is safe to cancel.
 */
export const RewindDraftState = Schema.Literals([
  "prepared",
  "provider-pending",
  "provider-confirmed",
  "files-confirmed",
  "completed",
  "reconciliation-required",
]);
export type RewindDraftState = typeof RewindDraftState.Type;

export const RewindDraft = Schema.Struct({
  operationId: CommandId,
  targetMessageId: Schema.optional(MessageId),
  restoreFiles: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  state: RewindDraftState,
});
export type RewindDraft = typeof RewindDraft.Type;

export const ThreadSettledBy = Schema.Literals(["user", "auto", "agent"]);
export type ThreadSettledBy = typeof ThreadSettledBy.Type;

export const ThreadPullRequestLink = Schema.Struct({
  ...SourceControlPullRequestRef.fields,
  repositoryPath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048), Schema.isPattern(/^https?:\/\//)),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;

/** The most links a thread shell carries; older links stay in the projection table. */
export const THREAD_PULL_REQUEST_SHELL_LIMIT = 20;

export const OrchestrationThread = Schema.Struct({
  sideChatOf: Schema.optional(Schema.NullOr(ThreadId)),
  /** PRs linked to this thread, newest first, at most `THREAD_PULL_REQUEST_SHELL_LIMIT`. */
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  scheduledOrigin: Schema.optional(Schema.NullOr(ScheduledOrigin)),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  settledBy: Schema.optional(Schema.NullOr(ThreadSettledBy)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  autoSettleDisabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  rewindDrafts: Schema.optional(Schema.Array(RewindDraft)),
  pendingUserInputs: Schema.optional(Schema.Array(PendingUserInput)),
  id: ThreadId,
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
  /** A scratch thread's own folder. Set only for threads of the scratch project. */
  scratchPath: Schema.optional(Schema.NullOr(FilesystemPath)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  pinOrderKey: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  titleSource: Schema.optional(ThreadTitleSource).pipe(
    Schema.withDecodingDefault(() => "legacy" as const),
  ),
  titleRevision: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  titleUpdatedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  lastInteractionAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  estimatedContextTokens: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  // Live thinking-token estimate (ephemeral per-turn progress, not persisted to
  // the projection DB). Defaults to null and shows blank after a cold reload
  // until the next thinking frame.
  estimatedThinkingTokens: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  modelContextWindowTokens: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  /**
   * Set only by the startup snapshot for archived threads: `proposedPlans` is
   * empty because it was not loaded, not because the thread has none. The
   * thread's tail details carry them.
   */
  proposedPlansOmitted: Schema.optional(Schema.Boolean),
  tasks: Schema.Array(TaskItem).pipe(Schema.withDecodingDefault(() => [])),
  tasksTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  tasksUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  tasksTracking: Schema.optional(Schema.NullOr(ThreadTaskTracking)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  compaction: Schema.NullOr(ThreadCompaction).pipe(Schema.withDecodingDefault(() => null)),
  sessionNotes: Schema.optional(Schema.NullOr(ThreadSessionNotes)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  threadReferences: Schema.optional(Schema.Array(ThreadReference)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  /**
   * Set by the server's in-memory read model for a thread that was archived
   * before startup: `activities` holds its worktree-setup activity only, and
   * the rest is still in SQLite. Cleared once the server loads them.
   */
  activitiesOmitted: Schema.optional(Schema.Boolean),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  pinRevision: Schema.optional(NonNegativeInt),
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  planningWorkflows: Schema.Array(PlanningWorkflow).pipe(Schema.withDecodingDefault(() => [])),
  codeReviewWorkflows: Schema.Array(CodeReviewWorkflow).pipe(Schema.withDecodingDefault(() => [])),
  investigationWorkflows: Schema.Array(InvestigationWorkflow).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;
