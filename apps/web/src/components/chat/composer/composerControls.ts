import type * as React from "react";

import type {
  ApprovalRequestId,
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ServerProvider,
} from "@t3tools/contracts";
import type { ClaudeTraitsPicker } from "~/components/chat/ClaudeTraitsPicker";
import type { ComposerPendingApprovalActions } from "~/components/chat/ComposerPendingApprovalActions";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import type { ImageAttachmentActionItem } from "~/components/chat/imageAttachmentActions";
import type { ProviderInstanceModelPicker } from "~/components/chat/ProviderInstanceModelPicker";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import type { NextTurnQueueThreadState } from "~/nextTurnQueueStore";
import type {
  PendingUserInputAnswerValue,
  PendingUserInputDraftAnswer,
  PendingUserInputProgress,
} from "~/pendingUserInput";
import type {
  ActivePlanState,
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
} from "~/session-logic";
import type { SessionPhase } from "~/types";

export type ComposerSendIntent = "auto" | "queue-tail" | "queue-head" | "send-now";
export type ComposerRuntimeMode =
  | "auto"
  | "approval-required"
  | "auto-accept-edits"
  | "full-access";
export type ComposerProvider =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "opencode"
  | "grok"
  | "antigravity";

/** Approvals and structured questions the agent is waiting on. */
export interface ComposerPendingInteraction {
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  activePendingProgress: PendingUserInputProgress | null;
  activePendingIsResponding: boolean;
  activePendingResolvedAnswers: Record<string, PendingUserInputAnswerValue> | null;
  isComposerApprovalState: boolean;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onToggleActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onRespondToApproval: React.ComponentProps<
    typeof ComposerPendingApprovalActions
  >["onRespondToApproval"];
}

/** Provider, model and provider-specific trait pickers. */
export interface ComposerModelControls {
  selectedProvider: ComposerProvider;
  selectedProviderInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedModelForPickerWithCustomFallback: string;
  hasThreadStarted: boolean;
  modelOptionsByInstance: React.ComponentProps<
    typeof ProviderInstanceModelPicker
  >["modelOptionsByInstance"];
  isClaudeUltrathink: boolean;
  providerStatuses: readonly ServerProvider[];
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  isModelPickerOpen: boolean;
  setIsModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onProviderModelSelect: React.ComponentProps<
    typeof ProviderInstanceModelPicker
  >["onInstanceModelChange"];
  /** Multi-model fan-out for a new thread's first message (empty draft, git project). */
  fanOutModels?: React.ComponentProps<typeof ProviderInstanceModelPicker>["selectedModels"];
  onToggleFanOutModel?: React.ComponentProps<typeof ProviderInstanceModelPicker>["onToggleModel"];
  showClaudeTraitsControls: boolean;
  selectedProviderModels: React.ComponentProps<typeof ClaudeTraitsPicker>["models"];
  selectedProviderModelOptions: React.ComponentProps<typeof ClaudeTraitsPicker>["modelOptions"];
  genericProviderTraitsPicker: React.ReactNode;
  genericProviderTraitsMenuContent: React.ReactNode;
}

/** Interaction mode, runtime mode, plan sidebar and conversation compaction. */
export interface ComposerModeControls {
  interactionMode: "default" | "plan";
  showInteractionModeToggle: boolean;
  toggleInteractionMode: () => void;
  runtimeMode: ComposerRuntimeMode;
  handleRuntimeModeChange: (mode: ComposerRuntimeMode) => void;
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  showPlanFollowUpPrompt: boolean;
  planSidebarOpen: boolean;
  togglePlanSidebar: () => void;
  canCompactConversation: boolean;
  onCompactConversation: () => Promise<void>;
}

/** Sending, queueing, interrupting and plan implementation. */
export interface ComposerSendControls {
  onSend: (event?: { preventDefault: () => void }, intent?: ComposerSendIntent) => Promise<void>;
  onInterrupt: () => Promise<void>;
  phase: SessionPhase;
  isConnecting: boolean;
  isWorking: boolean;
  isSendBusy: boolean;
  hasPendingTurnDispatch: boolean;
  isPendingTurnDispatchBlocked: boolean;
  composerSendState: {
    trimmedPrompt: string;
    sendableTerminalContexts: TerminalContextDraft[];
    expiredTerminalContextCount: number;
    hasSendableContent: boolean;
  };
  isComposerSendBusy: boolean;
  composerSendBusyLabel: "Preparing image" | "Sending";
  /** A conversation revert is running: typing stays allowed, sending waits for it. */
  revertInProgress: boolean;
  nextTurnQueueState: NextTurnQueueThreadState;
  isServerThread: boolean;
  isPreparingWorktree: boolean;
  isComposerImageImportPending: boolean;
  pendingComposerImageImportCount: number;
  planImplementationManagedByWorkflow: boolean;
  canImplementMergeFromChat: boolean;
  setWorkflowImplementDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onImplementPlanInNewThread: () => Promise<void>;
}

/** Images, file mentions, terminal contexts and drag-and-drop. */
export interface ComposerAttachments {
  composerImages: ComposerImageAttachment[];
  nonPersistedComposerImageIdSet: Set<string>;
  removeComposerImage: (imageId: string) => void;
  usesCustomImageContextMenu: boolean;
  onImageActionMenu: (item: ImageAttachmentActionItem, position: { x: number; y: number }) => void;
  setExpandedImage: React.Dispatch<React.SetStateAction<ExpandedImagePreview | null>>;
  composerFilePaths: string[];
  removeComposerFilePath: (filePath: string) => void;
  composerTerminalContexts: TerminalContextDraft[];
  removeComposerTerminalContextFromDraft: (contextId: string) => void;
  onAttachFiles: (files: File[]) => void;
  onComposerPaste: (event: React.ClipboardEvent<HTMLElement>) => void;
  isDragOverComposer: boolean;
  onComposerFileMentionDragEnterCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDragOverCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDragLeaveCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerFileMentionDropCapture: (event: React.DragEvent<HTMLDivElement>) => void;
}

/** Shared queue-derived props for both send-control states. */
export function composerQueueControlProps(state: NextTurnQueueThreadState) {
  const snapshot = state.snapshot;
  return {
    paused: snapshot?.paused ?? false,
    runnableQueueCount: snapshot?.paused
      ? 0
      : (snapshot?.items.filter((item) => item.status !== "failed").length ?? 0),
    itemCount: snapshot?.items.length ?? 0,
    maxItems: snapshot?.maxItems ?? 20,
  };
}
