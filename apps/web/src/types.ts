import type {
  OrchestrationCommandExecutionCursor,
  OrchestrationCommandExecutionSummary,
  CodeReviewWorkflowSummary as ContractCodeReviewWorkflow,
  InvestigationWorkflowSummary as ContractInvestigationWorkflow,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  OrchestrationThreadActivityCursor,
  OrchestrationMessageCursor,
  ThreadCompaction as ContractThreadCompaction,
  PlanningWorkflowSummary as ContractPlanningWorkflow,
  ProjectMemory as ContractProjectMemory,
  ProjectSkill as ContractProjectSkill,
  ProjectScript as ContractProjectScript,
  TaskItem as ContractTaskItem,
  ThreadTaskTracking,
  ThreadId,
  ThreadReference as ContractThreadReference,
  ThreadSessionNotes as ContractThreadSessionNotes,
  ThreadTitleRegeneration as ContractThreadTitleRegeneration,
  ThreadTitleSource,
  ProjectId,
  TurnId,
  MessageId,
  ModelSelection,
  CheckpointRef,
  ProviderKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ProjectIcon,
  ProjectKind,
  ThreadEnvMode,
  UserMessageSkillCall as ContractUserMessageSkillCall,
} from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export { DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;
export type PlanningWorkflow = ContractPlanningWorkflow;
export type CodeReviewWorkflow = ContractCodeReviewWorkflow;
export type InvestigationWorkflow = ContractInvestigationWorkflow;
export type TaskItem = ContractTaskItem;
export type ProjectMemory = ContractProjectMemory;
export type ProjectSkill = ContractProjectSkill;
export type ThreadReference = ContractThreadReference;
export type ThreadSessionNotes = ContractThreadSessionNotes;
export type ThreadCompaction = ContractThreadCompaction;
export type ThreadTitleRegeneration = ContractThreadTitleRegeneration;
export type ThreadHistoryMessageCursor = OrchestrationMessageCursor;
export type ThreadHistoryCommandExecutionCursor = OrchestrationCommandExecutionCursor;
export type ThreadHistoryActivityCursor = OrchestrationThreadActivityCursor;
export type UserMessageSkillCall = ContractUserMessageSkillCall;

export type ThreadHistoryStage = "empty" | "tail" | "backfilling" | "complete" | "error";

export interface ThreadHistoryState {
  stage: ThreadHistoryStage;
  hasOlderMessages: boolean;
  hasNewerMessages?: boolean;
  hasOlderCheckpoints: boolean;
  hasOlderActivities: boolean;
  hasNewerActivities?: boolean;
  hasOlderCommandExecutions: boolean;
  oldestLoadedMessageCursor: ThreadHistoryMessageCursor | null;
  newestLoadedMessageCursor?: ThreadHistoryMessageCursor | null;
  oldestLoadedCheckpointTurnCount: number | null;
  oldestLoadedActivityCursor: ThreadHistoryActivityCursor | null;
  newestLoadedActivityCursor?: ThreadHistoryActivityCursor | null;
  oldestLoadedCommandExecutionCursor: ThreadHistoryCommandExecutionCursor | null;
  generation: number;
}

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
  /** Persisted bytes URL when previewUrl is a temporary optimistic blob URL. */
  sourceUrl?: string;
  /** Original local bytes retained while an optimistic sent-image preview can remain open. */
  sourceBlob?: Blob;
}

export type ChatAttachment = Omit<ChatImageAttachment, "type"> & {
  type: "image" | "file";
  source?: "pasted-text" | "snapshot" | undefined;
};

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  reasoningText?: string;
  skillCall?: UserMessageSkillCall;
  attachments?: ChatAttachment[];
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  defaultModel?: string | null;
  defaultModelSelection?: ModelSelection | null | undefined;
  id: ProjectId;
  /** `scratch` is the server-owned home for threads without a project. */
  kind?: ProjectKind | undefined;
  name: string;
  cwd: string;
  model: string;
  createdAt: string;
  expanded: boolean;
  defaultEnvMode?: ThreadEnvMode | null;
  icon?: ProjectIcon | null;
  scripts: ProjectScript[];
  memories: ProjectMemory[];
  skills?: ProjectSkill[] | undefined;
}

export interface Thread {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  model: string;
  modelSelection?: ModelSelection | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  commandExecutions: OrchestrationCommandExecutionSummary[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  settledAt?: string | null;
  settledBy?: import("@t3tools/contracts").ThreadSettledBy | null;
  autoSettleDisabled?: boolean;
  pinnedAt?: string | null;
  pinOrderKey?: number | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  titleState?: import("@t3tools/contracts").ThreadTitleState | null;
  titleSource?: ThreadTitleSource;
  titleRevision?: number;
  titleUpdatedAt?: string | null;
  titleRegeneration?: ThreadTitleRegeneration | null;
  lastInteractionAt: string;
  estimatedContextTokens: number | null;
  estimatedThinkingTokens: number | null;
  modelContextWindowTokens: number | null;
  latestTurn: OrchestrationLatestTurn | null;
  lastVisitedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
  /** A thread without a project works in this folder of its own. */
  scratchPath?: string | null | undefined;
  compaction?: ThreadCompaction | null | undefined;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
  pendingUserInputs?: ReadonlyArray<import("@t3tools/contracts").PendingUserInput> | undefined;
  rewindDrafts?: ReadonlyArray<import("@t3tools/contracts").RewindDraft> | undefined;
  detailsLoaded: boolean;
  history?: ThreadHistoryState | undefined;
  tasks: TaskItem[];
  tasksTurnId: TurnId | null;
  tasksUpdatedAt: string | null;
  tasksTracking?: ThreadTaskTracking | null | undefined;
  sessionNotes?: ThreadSessionNotes | null | undefined;
  threadReferences?: ThreadReference[] | undefined;
}

/**
 * The list-level fields of a thread. `Thread` is assignable to it, so list
 * helpers typed against it accept both full threads (and unsaved drafts) and
 * summaries.
 *
 * `lastInteractionAt` is an ordering key here: it refreshes only when the
 * relative activity order of threads changes, so every streaming delta does
 * not produce a new summary. Sorting by it always matches sorting the live
 * threads. Render a live timestamp with `useThreadActivityAt` instead.
 */
export type ThreadListItem = Pick<
  Thread,
  | "id"
  | "projectId"
  | "title"
  | "titleState"
  | "titleSource"
  | "titleRevision"
  | "titleUpdatedAt"
  | "titleRegeneration"
  | "model"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "codexThreadId"
  | "createdAt"
  | "archivedAt"
  | "settledAt"
  | "settledBy"
  | "autoSettleDisabled"
  | "pinnedAt"
  | "pinOrderKey"
  | "snoozedUntil"
  | "snoozedAt"
  | "lastVisitedAt"
  | "lastInteractionAt"
  | "branch"
  | "worktreePath"
  | "scratchPath"
  | "threadReferences"
  | "error"
>;

export interface ThreadSession {
  provider: ProviderKind;
  providerInstanceId?: ProviderInstanceId | null | undefined;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  lastErrorId?: string | null;
  lastErrorOccurredAt?: string | null;
  usageLimit?: import("@t3tools/contracts").OrchestrationUsageLimit | null;
  tokenUsageSource?: "provider" | "estimated";
  /** Capabilities of the bound session generation (Release 2). */
  capabilities?: import("@t3tools/contracts").ProviderSessionCapabilities | null;
  orchestrationStatus: OrchestrationSessionStatus;
}
