import { Effect, Option, Schema, SchemaIssue, SchemaTransformation, Struct } from "effect";
import { CodeReviewWorkflow, CodeReviewWorkflowId } from "./codeReviewWorkflow";
import { McpProjectServersConfig } from "./mcpServer";
import { ProviderModelOptions, ProviderOptionSelections } from "./model";
import { PlanningWorkflow, PlanningWorkflowId, WorkflowModelSlot } from "./planningWorkflow";
import { ProviderInstanceId } from "./providerInstance";
import {
  isKnownProviderKind as isKnownProviderKindValue,
  ProviderKind as ProviderKindSchema,
} from "./providerKind";
import { TOOL_LIFECYCLE_ITEM_TYPES } from "./toolLifecycle";
import {
  ApprovalRequestId,
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
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  getStartupSnapshot: "orchestration.getStartupSnapshot",
  getThreadTailDetails: "orchestration.getThreadTailDetails",
  getThreadHistoryPage: "orchestration.getThreadHistoryPage",
  getThreadDetails: "orchestration.getThreadDetails",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  getThreadCommandExecutions: "orchestration.getThreadCommandExecutions",
  getThreadCommandExecution: "orchestration.getThreadCommandExecution",
  getThreadFileChanges: "orchestration.getThreadFileChanges",
  getThreadFileChange: "orchestration.getThreadFileChange",
  replayEvents: "orchestration.replayEvents",
  createWorkflow: "orchestration.createWorkflow",
  archiveWorkflow: "orchestration.archiveWorkflow",
  unarchiveWorkflow: "orchestration.unarchiveWorkflow",
  deleteWorkflow: "orchestration.deleteWorkflow",
  retryWorkflow: "orchestration.retryWorkflow",
  createCodeReviewWorkflow: "orchestration.createCodeReviewWorkflow",
  archiveCodeReviewWorkflow: "orchestration.archiveCodeReviewWorkflow",
  unarchiveCodeReviewWorkflow: "orchestration.unarchiveCodeReviewWorkflow",
  deleteCodeReviewWorkflow: "orchestration.deleteCodeReviewWorkflow",
  retryCodeReviewWorkflow: "orchestration.retryCodeReviewWorkflow",
  startImplementation: "orchestration.startImplementation",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
} as const;

export const ProviderKind = ProviderKindSchema;
export type ProviderKind = typeof ProviderKind.Type;
export const isKnownProviderKind = isKnownProviderKindValue;
export const DEFAULT_NEW_THREAD_TITLE = "New thread";
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

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ModelSelectionSource = Schema.Struct({
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

const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});

export const ClaudeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  permissionMode: Schema.optional(TrimmedNonEmptyString),
  maxThinkingTokens: Schema.optional(NonNegativeInt),
  subagentsEnabled: Schema.optional(Schema.Boolean),
  subagentModel: Schema.optional(TrimmedNonEmptyString),
  launchArgs: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

const CursorProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
});

const OpenCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
});

export const ProviderStartOptions = Schema.Struct({
  mcpServers: Schema.optional(McpProjectServersConfig),
  codex: Schema.optional(CodexProviderStartOptions),
  claudeAgent: Schema.optional(ClaudeProviderStartOptions),
  cursor: Schema.optional(CursorProviderStartOptions),
  opencode: Schema.optional(OpenCodeProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;
export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
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
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
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

export const ProjectSkill = Schema.Struct({
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
export type ProjectSkill = typeof ProjectSkill.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  reasoningText: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

export const TaskItemStatus = Schema.Literals(["pending", "in_progress", "completed"]);
export type TaskItemStatus = typeof TaskItemStatus.Type;

export const TaskItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
  activeForm: TrimmedNonEmptyString,
  status: TaskItemStatus,
});
export type TaskItem = typeof TaskItem.Type;

export const ThreadCompactionDirection = Schema.Literals(["from", "up_to"]);
export type ThreadCompactionDirection = typeof ThreadCompactionDirection.Type;

export const ThreadCompactionTrigger = Schema.Literals(["manual", "automatic"]);
export type ThreadCompactionTrigger = typeof ThreadCompactionTrigger.Type;

export const ThreadCompaction = Schema.Struct({
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

const CommandExecutionRecordFields = {
  id: OrchestrationCommandExecutionId,
  threadId: ThreadId,
  turnId: TurnId,
  providerItemId: Schema.NullOr(ProviderItemId),
  command: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.NullOr(TrimmedNonEmptyString),
  status: OrchestrationCommandExecutionStatus,
  detail: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
} as const;

const CommandExecutionRecordWithoutThread = Schema.Struct(
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

const FileChangeRecordFields = {
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

const FileChangeRecordWithoutThread = Schema.Struct(
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

const SourceProposedPlanReference = Schema.Struct({
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

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  turnCostUsd: Schema.optional(Schema.Number),
  estimatedContextTokens: Schema.optional(NonNegativeInt),
  modelContextWindowTokens: Schema.optional(NonNegativeInt),
  tokenUsageSource: Schema.optional(Schema.Literals(["provider", "estimated"])),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
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

const CompactToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);

const CompactToolActivityStatus = Schema.Literals([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);

export const CompactToolActivityPayload = Schema.Struct({
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
  mcpServerName: Schema.optional(TrimmedNonEmptyString),
  mcpToolName: Schema.optional(TrimmedNonEmptyString),
  mcpInput: Schema.optional(Schema.String),
  mcpResult: Schema.optional(Schema.String),
});
export type CompactToolActivityPayload = typeof CompactToolActivityPayload.Type;

export const CompactRuntimeConfiguredActivityPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  claudeCodeVersion: Schema.optional(TrimmedNonEmptyString),
  sessionId: Schema.optional(TrimmedNonEmptyString),
  fastModeState: Schema.optional(TrimmedNonEmptyString),
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
});
export type CompactRuntimeConfiguredActivityPayload =
  typeof CompactRuntimeConfiguredActivityPayload.Type;

export const CompactMcpStatusActivityStatus = Schema.Literals([
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
  toolCount: Schema.optional(NonNegativeInt),
});
export type CompactMcpStatusActivityPayload = typeof CompactMcpStatusActivityPayload.Type;

export const CompactMcpOauthActivityPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(Schema.String),
});
export type CompactMcpOauthActivityPayload = typeof CompactMcpOauthActivityPayload.Type;

const OrchestrationLatestTurnState = Schema.Literals([
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
  assistantMessageId: Schema.NullOr(MessageId),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThread = Schema.Struct({
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
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  lastInteractionAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  estimatedContextTokens: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  modelContextWindowTokens: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  tasks: Schema.Array(TaskItem).pipe(Schema.withDecodingDefault(() => [])),
  tasksTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  tasksUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  compaction: Schema.NullOr(ThreadCompaction).pipe(Schema.withDecodingDefault(() => null)),
  sessionNotes: Schema.optional(Schema.NullOr(ThreadSessionNotes)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  threadReferences: Schema.optional(Schema.Array(ThreadReference)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  planningWorkflows: Schema.Array(PlanningWorkflow).pipe(Schema.withDecodingDefault(() => [])),
  codeReviewWorkflows: Schema.Array(CodeReviewWorkflow).pipe(Schema.withDecodingDefault(() => [])),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(ModelSelection),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModel: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

const ProjectMemorySaveCommand = Schema.Struct({
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

const ProjectMemoryUpdateCommand = Schema.Struct({
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

const ProjectMemoryDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.memory.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  memoryId: TrimmedNonEmptyString,
  deletedAt: IsoDateTime,
});

const ProjectSkillsReplaceCommand = Schema.Struct({
  type: Schema.Literal("project.skills.replace"),
  commandId: CommandId,
  projectId: ProjectId,
  skills: Schema.Array(ProjectSkill),
  updatedAt: IsoDateTime,
});

const ProjectWorkflowCreateCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.create"),
  commandId: CommandId,
  workflowId: PlanningWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  requirementPrompt: TrimmedNonEmptyString,
  plansDirectory: TrimmedNonEmptyString,
  authorThreadIdA: ThreadId,
  authorThreadIdB: ThreadId,
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  branchA: WorkflowModelSlot,
  branchB: WorkflowModelSlot,
  merge: WorkflowModelSlot,
  createdAt: IsoDateTime,
});

const ProjectWorkflowDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.delete"),
  commandId: CommandId,
  workflowId: PlanningWorkflowId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ProjectCodeReviewWorkflowCreateCommand = Schema.Struct({
  type: Schema.Literal("project.code-review-workflow.create"),
  commandId: CommandId,
  workflowId: CodeReviewWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  reviewPrompt: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  reviewerA: WorkflowModelSlot,
  reviewerB: WorkflowModelSlot,
  consolidation: WorkflowModelSlot,
  reviewerThreadIdA: ThreadId,
  reviewerThreadIdB: ThreadId,
  createdAt: IsoDateTime,
});

const ProjectCodeReviewWorkflowUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.code-review-workflow.upsert"),
  commandId: CommandId,
  projectId: ProjectId,
  workflow: CodeReviewWorkflow,
  updatedAt: IsoDateTime,
});

const ProjectCodeReviewWorkflowDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.code-review-workflow.delete"),
  commandId: CommandId,
  workflowId: CodeReviewWorkflowId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ThreadCreateCommand = Schema.Struct({
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
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  threadReferences: Schema.optional(Schema.Array(ThreadReference)),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type ThreadTurnStartBootstrapCreateThread = typeof ThreadTurnStartBootstrapCreateThread.Type;

export const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
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
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
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
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
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
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadCompactRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.compact.request"),
  commandId: CommandId,
  threadId: ThreadId,
  trigger: ThreadCompactionTrigger.pipe(Schema.withDecodingDefault(() => "manual" as const)),
  direction: Schema.optional(ThreadCompactionDirection),
  pivotMessageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
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
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
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
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  ThreadCompactRequestCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
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

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
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

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadTasksUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.tasks.update"),
  commandId: CommandId,
  threadId: ThreadId,
  tasks: Schema.Array(TaskItem),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadCompactedRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.compacted.record"),
  commandId: CommandId,
  threadId: ThreadId,
  compaction: ThreadCompaction,
  createdAt: IsoDateTime,
});

const ThreadSessionNotesRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.session-notes.record"),
  commandId: CommandId,
  threadId: ThreadId,
  sessionNotes: ThreadSessionNotes,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadCommandExecutionRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.command-execution.record"),
  commandId: CommandId,
  threadId: ThreadId,
  commandExecution: CommandExecutionRecordWithoutThread,
  createdAt: IsoDateTime,
});

const ThreadCommandExecutionOutputAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.command-execution.output.append"),
  commandId: CommandId,
  threadId: ThreadId,
  commandExecutionId: OrchestrationCommandExecutionId,
  chunk: Schema.String,
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadFileChangeRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.file-change.record"),
  commandId: CommandId,
  threadId: ThreadId,
  fileChange: Schema.Struct({
    ...FileChangeRecordWithoutThread.fields,
    patch: Schema.String,
  }),
  createdAt: IsoDateTime,
});

const ProjectWorkflowUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.upsert"),
  commandId: CommandId,
  projectId: ProjectId,
  workflow: PlanningWorkflow,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ProjectSkillsReplaceCommand,
  ProjectWorkflowUpsertCommand,
  ProjectCodeReviewWorkflowCreateCommand,
  ProjectCodeReviewWorkflowUpsertCommand,
  ProjectCodeReviewWorkflowDeleteCommand,
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadTasksUpdateCommand,
  ThreadCompactedRecordCommand,
  ThreadSessionNotesRecordCommand,
  ThreadRevertCompleteCommand,
  ThreadCommandExecutionRecordCommand,
  ThreadCommandExecutionOutputAppendCommand,
  ThreadFileChangeRecordCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

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
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.tasks.updated",
  "thread.compact-requested",
  "thread.compacted",
  "thread.session-notes-recorded",
  "thread.command-execution-recorded",
  "thread.command-execution-output-appended",
  "thread.file-change-recorded",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
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

export const ThreadCreatedPayload = Schema.Struct({
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
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  threadReferences: Schema.optional(Schema.Array(ThreadReference)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  unarchivedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
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
  reasoningText: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
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

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
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

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadTasksUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  tasks: Schema.Array(TaskItem),
  turnId: Schema.NullOr(TurnId),
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
});

export const ThreadFileChangeRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  fileChange: Schema.Struct({
    ...FileChangeRecordWithoutThread.fields,
    patch: Schema.String,
  }),
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
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
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
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
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
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
    type: Schema.Literal("thread.file-change-recorded"),
    payload: ThreadFileChangeRecordedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

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

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
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
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
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

export const OrchestrationThreadDetails = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  tasks: Schema.Array(TaskItem).pipe(Schema.withDecodingDefault(() => [])),
  tasksTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  tasksUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  sessionNotes: Schema.NullOr(ThreadSessionNotes).pipe(Schema.withDecodingDefault(() => null)),
  threadReferences: Schema.Array(ThreadReference).pipe(Schema.withDecodingDefault(() => [])),
  detailSequence: NonNegativeInt,
});
export type OrchestrationThreadDetails = typeof OrchestrationThreadDetails.Type;

export const OrchestrationGetThreadTailDetailsInput = Schema.Struct({
  threadId: ThreadId,
  messageLimit: Schema.optional(NonNegativeInt),
  checkpointLimit: Schema.optional(NonNegativeInt),
});
export type OrchestrationGetThreadTailDetailsInput =
  typeof OrchestrationGetThreadTailDetailsInput.Type;

export const OrchestrationThreadTailDetails = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  activities: Schema.Array(OrchestrationThreadActivity).pipe(Schema.withDecodingDefault(() => [])),
  commandExecutions: Schema.Array(OrchestrationCommandExecutionSummary).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  tasks: Schema.Array(TaskItem).pipe(Schema.withDecodingDefault(() => [])),
  tasksTurnId: Schema.NullOr(TurnId).pipe(Schema.withDecodingDefault(() => null)),
  tasksUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  sessionNotes: Schema.NullOr(ThreadSessionNotes).pipe(Schema.withDecodingDefault(() => null)),
  threadReferences: Schema.Array(ThreadReference).pipe(Schema.withDecodingDefault(() => [])),
  hasOlderMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderCheckpoints: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderCommandExecutions: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  oldestLoadedMessageCursor: Schema.NullOr(OrchestrationMessageCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
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
  beforeMessageCursor: Schema.NullOr(OrchestrationMessageCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  beforeCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  beforeCommandExecutionCursor: Schema.NullOr(OrchestrationCommandExecutionCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  messageLimit: Schema.optional(NonNegativeInt),
  checkpointLimit: Schema.optional(NonNegativeInt),
  commandExecutionLimit: Schema.optional(NonNegativeInt),
});
export type OrchestrationGetThreadHistoryPageInput =
  typeof OrchestrationGetThreadHistoryPageInput.Type;

export const OrchestrationThreadHistoryPage = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  commandExecutions: Schema.Array(OrchestrationCommandExecutionSummary).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  hasOlderMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderCheckpoints: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasOlderCommandExecutions: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  oldestLoadedMessageCursor: Schema.NullOr(OrchestrationMessageCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedCheckpointTurnCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  oldestLoadedCommandExecutionCursor: Schema.NullOr(OrchestrationCommandExecutionCursor).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  detailSequence: NonNegativeInt,
});
export type OrchestrationThreadHistoryPage = typeof OrchestrationThreadHistoryPage.Type;

export const OrchestrationGetStartupSnapshotResult = Schema.Struct({
  snapshot: OrchestrationReadModel,
  threadTailDetails: Schema.NullOr(OrchestrationThreadTailDetails).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type OrchestrationGetStartupSnapshotResult =
  typeof OrchestrationGetStartupSnapshotResult.Type;

const OrchestrationGetThreadDetailsResult = OrchestrationThreadDetails;
export type OrchestrationGetThreadDetailsResult = typeof OrchestrationGetThreadDetailsResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
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

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationCreateWorkflowInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  requirementPrompt: TrimmedNonEmptyString,
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  plansDirectory: Schema.optional(TrimmedNonEmptyString),
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  branchA: WorkflowModelSlot,
  branchB: WorkflowModelSlot,
  merge: WorkflowModelSlot,
});
export type OrchestrationCreateWorkflowInput = typeof OrchestrationCreateWorkflowInput.Type;

export const OrchestrationCreateWorkflowResult = Schema.Struct({
  workflowId: PlanningWorkflowId,
});
export type OrchestrationCreateWorkflowResult = typeof OrchestrationCreateWorkflowResult.Type;

export const OrchestrationCreateCodeReviewWorkflowInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  reviewPrompt: TrimmedNonEmptyString,
  titleGenerationModel: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  reviewerA: WorkflowModelSlot,
  reviewerB: WorkflowModelSlot,
  consolidation: WorkflowModelSlot,
});
export type OrchestrationCreateCodeReviewWorkflowInput =
  typeof OrchestrationCreateCodeReviewWorkflowInput.Type;

export const OrchestrationCreateCodeReviewWorkflowResult = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
});
export type OrchestrationCreateCodeReviewWorkflowResult =
  typeof OrchestrationCreateCodeReviewWorkflowResult.Type;

export const OrchestrationDeleteWorkflowInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
});
export type OrchestrationDeleteWorkflowInput = typeof OrchestrationDeleteWorkflowInput.Type;

export const OrchestrationArchiveWorkflowInput = OrchestrationDeleteWorkflowInput;
export type OrchestrationArchiveWorkflowInput = typeof OrchestrationArchiveWorkflowInput.Type;

export const OrchestrationUnarchiveWorkflowInput = OrchestrationDeleteWorkflowInput;
export type OrchestrationUnarchiveWorkflowInput = typeof OrchestrationUnarchiveWorkflowInput.Type;

export const OrchestrationDeleteCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
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

export const OrchestrationRetryWorkflowInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
});
export type OrchestrationRetryWorkflowInput = typeof OrchestrationRetryWorkflowInput.Type;

export const OrchestrationRetryCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
  scope: Schema.optional(Schema.Literals(["failed", "consolidation"])).pipe(
    Schema.withDecodingDefault(() => "failed" as const),
  ),
});
export type OrchestrationRetryCodeReviewWorkflowInput =
  typeof OrchestrationRetryCodeReviewWorkflowInput.Type;

export const OrchestrationStartImplementationInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  modelOptions: Schema.optional(ProviderModelOptions),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  codeReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  envMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withDecodingDefault(() => "local" as const),
  ),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationStartImplementationInput =
  typeof OrchestrationStartImplementationInput.Type;

export const OrchestrationRpcSchemas = {
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
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
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
  archiveCodeReviewWorkflow: {
    input: OrchestrationArchiveCodeReviewWorkflowInput,
    output: Schema.Void,
  },
  unarchiveCodeReviewWorkflow: {
    input: OrchestrationUnarchiveCodeReviewWorkflowInput,
    output: Schema.Void,
  },
  deleteWorkflow: {
    input: OrchestrationDeleteWorkflowInput,
    output: Schema.Void,
  },
  deleteCodeReviewWorkflow: {
    input: OrchestrationDeleteCodeReviewWorkflowInput,
    output: Schema.Void,
  },
  retryWorkflow: {
    input: OrchestrationRetryWorkflowInput,
    output: Schema.Void,
  },
  retryCodeReviewWorkflow: {
    input: OrchestrationRetryCodeReviewWorkflowInput,
    output: Schema.Void,
  },
  startImplementation: {
    input: OrchestrationStartImplementationInput,
    output: Schema.Void,
  },
} as const;
