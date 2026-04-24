import type {
  OrchestrationCommandExecutionCursor,
  OrchestrationCommandExecutionSummary,
  CodeReviewWorkflow as ContractCodeReviewWorkflow,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  OrchestrationMessageCursor,
  ThreadCompaction as ContractThreadCompaction,
  PlanningWorkflow as ContractPlanningWorkflow,
  ProjectMemory as ContractProjectMemory,
  ProjectSkill as ContractProjectSkill,
  ProjectScript as ContractProjectScript,
  TaskItem as ContractTaskItem,
  ThreadId,
  ThreadReference as ContractThreadReference,
  ThreadSessionNotes as ContractThreadSessionNotes,
  ProjectId,
  TurnId,
  MessageId,
  CheckpointRef,
  ProviderKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;
export type PlanningWorkflow = ContractPlanningWorkflow;
export type CodeReviewWorkflow = ContractCodeReviewWorkflow;
export type TaskItem = ContractTaskItem;
export type ProjectMemory = ContractProjectMemory;
export type ProjectSkill = ContractProjectSkill;
export type ThreadReference = ContractThreadReference;
export type ThreadSessionNotes = ContractThreadSessionNotes;
export type ThreadCompaction = ContractThreadCompaction;
export type ThreadHistoryMessageCursor = OrchestrationMessageCursor;
export type ThreadHistoryCommandExecutionCursor = OrchestrationCommandExecutionCursor;

export type ThreadHistoryStage = "empty" | "tail" | "backfilling" | "complete" | "error";

export interface ThreadHistoryState {
  stage: ThreadHistoryStage;
  hasOlderMessages: boolean;
  hasOlderCheckpoints: boolean;
  hasOlderCommandExecutions: boolean;
  oldestLoadedMessageCursor: ThreadHistoryMessageCursor | null;
  oldestLoadedCheckpointTurnCount: number | null;
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
}

export type ChatAttachment = ChatImageAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  reasoningText?: string;
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
  id: ProjectId;
  name: string;
  cwd: string;
  model: string;
  createdAt: string;
  expanded: boolean;
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
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  commandExecutions: OrchestrationCommandExecutionSummary[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  lastInteractionAt: string;
  estimatedContextTokens: number | null;
  modelContextWindowTokens: number | null;
  latestTurn: OrchestrationLatestTurn | null;
  lastVisitedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
  compaction?: ThreadCompaction | null | undefined;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
  detailsLoaded: boolean;
  history?: ThreadHistoryState | undefined;
  tasks: TaskItem[];
  tasksTurnId: TurnId | null;
  tasksUpdatedAt: string | null;
  sessionNotes?: ThreadSessionNotes | null | undefined;
  threadReferences?: ThreadReference[] | undefined;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  tokenUsageSource?: "provider" | "estimated";
  orchestrationStatus: OrchestrationSessionStatus;
}
