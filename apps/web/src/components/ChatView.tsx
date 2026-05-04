import {
  type ApprovalRequestId,
  type CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  type EditorId,
  type KeybindingCommand,
  type MessageId,
  type OrchestrationCommandExecutionSummary,
  type OrchestrationGetThreadFileChangesResult,
  type OrchestrationFileChangeId,
  type OrchestrationFileChangeSummary,
  type ProjectId,
  type ProjectEntry,
  type ProjectScript,
  type ModelSlug,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ResolvedKeybindingsConfig,
  type ProviderApprovalDecision,
  type ServerProviderStatus,
  type ProviderKind,
  type ProviderModelOptions,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  RuntimeMode,
  ProviderInteractionMode,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  inferProviderForModel,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeModelSlug,
  resolveModelSlugForProvider,
  supportsClaudeUltrathinkKeyword,
} from "@t3tools/shared/model";
import {
  readMcpStatusActivityPayload,
  readRuntimeConfiguredPayload,
} from "@t3tools/shared/orchestrationActivityPayload";
import { parseClaudeLaunchArgs } from "@t3tools/shared/cliArgs";
import { areProviderModelOptionsEqual } from "@t3tools/shared/providerOptions";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { providerQueryKeys } from "~/lib/providerReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { isElectron } from "../env";
import {
  clearDiffSearchParams,
  clearFileViewSearchParams,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { FileNavigationProvider } from "../fileNavigationContext";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  createLocalDispatchSnapshot,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasServerAcknowledgedLocalDispatch,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { Debouncer } from "@tanstack/react-pacer";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOption,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import {
  deletePendingTurnDispatchArtifacts,
  getPendingTurnDispatchArtifacts,
  listPendingTurnDispatchArtifacts,
  setPendingTurnDispatchArtifacts,
  type PendingTurnDispatchState,
  type PendingTurnStartCommand,
  usePendingTurnDispatchStore,
} from "../pendingTurnDispatchStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "../transportError";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { normalizeGeneratedThreadTitle } from "../threadTitle";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type CodeReviewWorkflow,
  type PlanningWorkflow,
  type TaskItem as ThreadTaskItem,
  type TurnDiffSummary,
} from "../types";
import { basenameOfPath } from "../vscode-icons";
import { useTheme } from "../hooks/useTheme";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import {
  fetchThreadFileChangesDelta,
  fullThreadFileChangesQueryOptions,
  mergeThreadFileChangesResult,
  orchestrationQueryKeys,
  retryThreadHistoryBackfill,
} from "../lib/orchestrationReactQuery";
import { buildLocalDraftThread } from "../lib/draftThreads";
import { ensureThreadHistoryState } from "../lib/threadHistory";
import { finishThreadOpenTrace } from "../lib/threadOpenTrace";
import { isTerminalFocused } from "../lib/terminalFocus";
import { recordModelSelection } from "../modelPreferencesStore";
import { isWsInteractionBlocked, useWsConnectionState } from "../wsConnectionState";
import BranchToolbar from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import { RightPanelSheet } from "./RightPanelSheet";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { workflowContainsThread } from "./workflow/workflowUtils";
import { codeReviewWorkflowContainsThread } from "./workflow/codeReviewWorkflowUtils";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  NotebookPenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { cn, randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { SidebarTrigger } from "./ui/sidebar";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  getClaudeProjectSettings,
  resolveAppModelSelection,
  resolveThreadTitleModel,
  useAppSettings,
} from "../appSettings";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import {
  appendAttachedFilesToPrompt,
  relativePathForDisplay,
  sanitizeAttachedFileReferencePaths,
} from "../lib/attachedFiles";
import {
  normalizeFilePathForDiffLookup,
  shouldOpenFileInDiffPanel,
} from "../lib/normalizeFilePathForDiff";
import {
  appendTerminalContextsToPrompt,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { shouldUseCompactComposerFooter } from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { type ChatDiffContext, MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatHeader } from "./chat/ChatHeader";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import {
  ClaudeTraitsMenuContent,
  ClaudeTraitsPicker,
  supportsClaudeTraitsControls,
} from "./chat/ClaudeTraitsPicker";
import { CodexTraitsMenuContent, CodexTraitsPicker } from "./chat/CodexTraitsPicker";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./chat/ComposerPlanFollowUpBanner";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ProviderRuntimeInfoBanner } from "./chat/ProviderRuntimeInfoBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { PendingSendRecoveryBanner } from "./chat/PendingSendRecoveryBanner";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import {
  buildComposerSkillReplacement,
  buildFirstSendBootstrap,
  buildSlashComposerMenuItems,
  deriveProviderRuntimeInfoEntries,
  buildExpiredTerminalContextToastCopy,
  shouldRenderTimelineContent,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  createCachedAbsolutePathComparisonNormalizer,
  deriveComposerSendState,
  getCustomModelOptionsByProvider,
  identityAbsolutePathNormalizer,
  DISMISSED_PROVIDER_STATUS_KEY,
  DismissedProviderStatusSchema,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type PendingTurnDispatchRollback,
  PullRequestDialogState,
  readFileAsDataUrl,
  resolveAttachedFileReferencePaths,
  rewriteComposerRuntimeSkillInvocationForSend,
  revokeBlobPreviewUrl,
  revokeComposerImagePreviewUrls,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Skeleton } from "./ui/skeleton";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_COMMAND_EXECUTIONS: OrchestrationCommandExecutionSummary[] = [];
const EMPTY_TASKS: ThreadTaskItem[] = [];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

type NativeApiClient = NonNullable<ReturnType<typeof readNativeApi>>;
type PendingTurnDispatch = PendingTurnDispatchState;

function resolvePlanningWorkflowThreadSlot(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
): WorkflowModelSlot | null {
  if (workflow.branchA.authorThreadId === threadId) {
    return workflow.branchA.authorSlot;
  }
  if (workflow.branchB.authorThreadId === threadId) {
    return workflow.branchB.authorSlot;
  }
  if (workflow.merge.threadId === threadId) {
    return workflow.merge.mergeSlot;
  }
  const branchAReview = workflow.branchA.reviews.find((review) => review.threadId === threadId);
  if (branchAReview) {
    return branchAReview.slot === "cross"
      ? workflow.branchB.authorSlot
      : workflow.branchA.authorSlot;
  }
  const branchBReview = workflow.branchB.reviews.find((review) => review.threadId === threadId);
  if (branchBReview) {
    return branchBReview.slot === "cross"
      ? workflow.branchA.authorSlot
      : workflow.branchB.authorSlot;
  }
  if (workflow.implementation?.threadId === threadId) {
    return workflow.implementation.implementationSlot;
  }
  const codeReview = workflow.implementation?.codeReviews.find(
    (review) => review.threadId === threadId,
  );
  return codeReview?.reviewerSlot ?? null;
}

function resolveCodeReviewWorkflowThreadSlot(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
): WorkflowModelSlot | null {
  if (workflow.reviewerA.threadId === threadId) {
    return workflow.reviewerA.slot;
  }
  if (workflow.reviewerB.threadId === threadId) {
    return workflow.reviewerB.slot;
  }
  if (workflow.consolidation.threadId === threadId) {
    return workflow.consolidation.slot;
  }
  return null;
}

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

const TASK_STATUS_META = {
  pending: {
    label: "Pending",
    accentClass: "border-amber-500/30 bg-amber-500/6 text-amber-700 dark:text-amber-300",
    dotClass: "bg-amber-500/80",
  },
  in_progress: {
    label: "In progress",
    accentClass: "border-sky-500/30 bg-sky-500/8 text-sky-700 dark:text-sky-300",
    dotClass: "bg-sky-500",
  },
  completed: {
    label: "Completed",
    accentClass: "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
  },
} as const satisfies Record<
  ThreadTaskItem["status"],
  { label: string; accentClass: string; dotClass: string }
>;

function summarizeTaskCounts(tasks: ReadonlyArray<ThreadTaskItem>): string {
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  } satisfies Record<ThreadTaskItem["status"], number>;

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return [
    counts.in_progress > 0 ? `${counts.in_progress} active` : null,
    counts.pending > 0 ? `${counts.pending} pending` : null,
    counts.completed > 0 ? `${counts.completed} done` : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" · ");
}

function deriveFallbackTasksFromPlan(
  activePlan: ReturnType<typeof deriveActivePlanState>,
): ThreadTaskItem[] {
  if (!activePlan || activePlan.steps.length === 0) {
    return [];
  }

  return activePlan.steps.map((step, index) => ({
    id: `plan-step:${index}`,
    content: step.step,
    activeForm: step.step,
    status:
      step.status === "completed"
        ? "completed"
        : step.status === "inProgress"
          ? "in_progress"
          : "pending",
  }));
}

function ThreadTasksPanel(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<ThreadTaskItem>;
  readonly open: boolean;
  readonly summary: string;
  readonly onToggle: () => void;
}) {
  const panelId = `thread-task-panel-${input.threadId}`;

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm backdrop-blur-sm">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35"
        onClick={input.onToggle}
        aria-controls={panelId}
        aria-expanded={input.open}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ListTodoIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-foreground text-sm">Task list</span>
          </div>
          <p className="truncate pt-0.5 text-muted-foreground text-xs">{input.summary}</p>
        </div>
        {input.open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          input.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-70",
        )}
      >
        <div id={panelId} className="overflow-hidden">
          <div className="space-y-2 border-t border-border/60 px-4 py-3">
            {input.tasks.map((task) => {
              const meta = TASK_STATUS_META[task.status];
              return (
                <div
                  key={task.id}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border px-3 py-2 transition-colors duration-200",
                    meta.accentClass,
                  )}
                >
                  <span
                    className={cn(
                      "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-200",
                      meta.dotClass,
                      task.status === "in_progress" ? "animate-pulse" : "",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">{task.activeForm}</p>
                    {task.content !== task.activeForm ? (
                      <p className="truncate pt-0.5 text-muted-foreground text-xs">
                        {task.content}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-full border border-current/15 px-2 py-0.5 font-medium text-[11px] uppercase tracking-[0.08em]">
                    {meta.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

interface ChatViewProps {
  threadId: ThreadId;
}

export default function ChatView({ threadId }: ChatViewProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const planningWorkflows = useStore((store) => store.planningWorkflows);
  const codeReviewWorkflows = useStore((store) => store.codeReviewWorkflows);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setStoreThreadError = useStore((store) => store.setError);
  const setChangedFilesExpandedForThread = useStore(
    (store) => store.setChangedFilesExpandedForThread,
  );
  const changedFilesExpandedByThreadId = useStore((store) => store.changedFilesExpandedByThreadId);
  const { settings } = useAppSettings();
  const timestampFormat = settings.timestampFormat;
  const wsConnectionState = useWsConnectionState();
  const wsInteractionBlocked = isWsInteractionBlocked(wsConnectionState.phase);
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerFilePaths = composerDraft.filePaths;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        filePathCount: composerFilePaths.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerFilePaths.length, composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftFilePaths = useComposerDraftStore((store) => store.setFilePaths);
  const setComposerDraftProvider = useComposerDraftStore((store) => store.setProvider);
  const setComposerDraftModel = useComposerDraftStore((store) => store.setModel);
  const setComposerDraftModelOptions = useComposerDraftStore((store) => store.setModelOptions);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFilePaths = useComposerDraftStore((store) => store.addFilePaths);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const removeComposerDraftFilePath = useComposerDraftStore((store) => store.removeFilePath);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const promptRef = useRef(prompt);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerFilePathsRef = useRef<string[]>(composerFilePaths);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const pendingTurnDispatch = usePendingTurnDispatchStore(
    (store) => store.pendingByThreadId[threadId] ?? null,
  );
  const setStorePendingTurnDispatch = usePendingTurnDispatchStore(
    (store) => store.setPendingTurnDispatch,
  );
  const updateStorePendingTurnDispatch = usePendingTurnDispatchStore(
    (store) => store.updatePendingTurnDispatch,
  );
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [expandedFileChangeDiffs, setExpandedFileChangeDiffs] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedCommandExecutions, setExpandedCommandExecutions] = useState<
    Record<string, boolean>
  >({});
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const previousTaskPanelThreadIdRef = useRef<ThreadId | null>(null);
  const previousThreadTaskCountRef = useRef(0);
  const tasksPanelManuallyCollapsedRef = useRef(false);
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const pendingTurnDispatchRef = useRef<PendingTurnDispatch | null>(null);
  pendingTurnDispatchRef.current = pendingTurnDispatch;
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const scrollToEnd = useCallback((animated = false) => {
    legendListRef.current?.scrollToEnd?.({ animated });
  }, []);
  // Pin the scroll position to the bottom before a new row is appended.
  // Flipping `isAtEndRef`/`setShowScrollToBottom` optimistically is only safe
  // once LegendList is mounted and can observe the scroll position - otherwise
  // the debouncer-driven pill fights the optimistic state the moment the user
  // nudges the wheel. When the ref isn't attached yet (first send before the
  // list has mounted) retry on the next animation frame so the flip applies
  // as soon as the list is available.
  const pinToEnd = useCallback(() => {
    const list = legendListRef.current;
    if (!list) {
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => pinToEnd());
      }
      return;
    }
    isAtEndRef.current = true;
    showScrollDebouncer.current?.cancel();
    setShowScrollToBottom(false);
    list.scrollToEnd?.({ animated: true });
  }, []);
  // Lazy-init so the Debouncer instance is constructed exactly once — passing
  // `new Debouncer(...)` directly to `useRef` would allocate a fresh instance on
  // every render (only the first is retained, the rest are thrown away).
  const showScrollDebouncer = useRef<Debouncer<() => void> | null>(null);
  if (showScrollDebouncer.current === null) {
    showScrollDebouncer.current = new Debouncer(() => setShowScrollToBottom(true), { wait: 150 });
  }
  useEffect(() => {
    const debouncer = showScrollDebouncer.current;
    return () => {
      // Cancel any pending timer so the `setShowScrollToBottom` callback cannot
      // fire after the component unmounts.
      debouncer?.cancel();
    };
  }, []);
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      showScrollDebouncer.current?.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current?.maybeExecute();
    }
  }, []);

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerFilePathsToDraft = useCallback(
    (filePaths: string[]) => {
      addComposerDraftFilePaths(threadId, filePaths);
    },
    [addComposerDraftFilePaths, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const removeComposerFilePathFromDraft = useCallback(
    (filePath: string) => {
      removeComposerDraftFilePath(threadId, filePath);
    },
    [removeComposerDraftFilePath, threadId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      if (pendingTurnDispatchRef.current) {
        return;
      }
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [composerTerminalContexts, removeComposerDraftTerminalContext, setPrompt, threadId],
  );

  const serverThread = threads.find((t) => t.id === threadId);
  const fallbackDraftProject = projects.find((project) => project.id === draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread({
            threadId,
            draftThread,
            projectModel: fallbackDraftProject?.model ?? DEFAULT_MODEL_BY_PROVIDER.codex,
            error: localDraftError,
          })
        : undefined,
    [draftThread, fallbackDraftProject?.model, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  const activeWorkflow = useMemo(() => {
    if (activeThread == null) {
      return null;
    }
    const planningWorkflow = planningWorkflows.find((workflow) =>
      workflowContainsThread(workflow, activeThread.id),
    );
    if (planningWorkflow) {
      return {
        workflow: planningWorkflow,
        type: "planning" as const,
      };
    }
    const codeReviewWorkflow = codeReviewWorkflows.find((workflow) =>
      codeReviewWorkflowContainsThread(workflow, activeThread.id),
    );
    if (codeReviewWorkflow) {
      return {
        workflow: codeReviewWorkflow,
        type: "codeReview" as const,
      };
    }
    return null;
  }, [activeThread, codeReviewWorkflows, planningWorkflows]);
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = projects.find((p) => p.id === activeThread?.projectId);
  const workspaceRoot = activeThread?.worktreePath ?? activeProject?.cwd ?? undefined;
  const workflowThreadSlot = useMemo(() => {
    if (!activeThread || !activeWorkflow) {
      return null;
    }
    return activeWorkflow.type === "planning"
      ? resolvePlanningWorkflowThreadSlot(activeWorkflow.workflow, activeThread.id)
      : resolveCodeReviewWorkflowThreadSlot(activeWorkflow.workflow, activeThread.id);
  }, [activeThread, activeWorkflow]);

  useEffect(() => {
    if (!workflowThreadSlot) {
      return;
    }
    if (composerDraft.provider === null) {
      setComposerDraftProvider(threadId, workflowThreadSlot.provider);
    }
    if (composerDraft.model === null) {
      setComposerDraftModel(threadId, workflowThreadSlot.model);
    }
    const nextModelOptions: ProviderModelOptions | null = workflowThreadSlot.modelOptions ?? null;
    if (
      composerDraft.modelOptions === null &&
      nextModelOptions !== null &&
      !areProviderModelOptionsEqual(composerDraft.modelOptions, nextModelOptions)
    ) {
      setComposerDraftModelOptions(threadId, nextModelOptions);
    }
  }, [
    composerDraft.model,
    composerDraft.modelOptions,
    composerDraft.provider,
    setComposerDraftModel,
    setComposerDraftModelOptions,
    setComposerDraftProvider,
    threadId,
    workflowThreadSlot,
  ]);

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, input);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, input);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (!isServerThread && activeDraftThread?.projectId === activeProject.id) {
        setDraftThreadContext(threadId, input);
        setProjectDraftThreadId(activeProject.id, threadId, input);
        return;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(activeThread.id);
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    markThreadVisited,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.provider;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const inferredThreadProvider =
    activeThread && activeThread.session === null && !selectedProviderByThreadId
      ? inferProviderForModel(activeThread.model, "codex")
      : null;
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const selectedProvider: ProviderKind =
    lockedProvider ?? selectedProviderByThreadId ?? inferredThreadProvider ?? "codex";
  const baseThreadModel = resolveModelSlugForProvider(
    selectedProvider,
    activeThread?.model ?? activeProject?.model ?? getDefaultModel(selectedProvider),
  );
  const customModelsByProvider = useMemo(
    () => ({
      codex: settings.customCodexModels,
      claudeAgent: settings.customClaudeModels,
    }),
    [settings.customClaudeModels, settings.customCodexModels],
  );
  const customModelsForSelectedProvider = customModelsByProvider[selectedProvider];
  const selectedModel = useMemo(() => {
    const draftModel = composerDraft.model;
    if (!draftModel) {
      return baseThreadModel;
    }
    return resolveAppModelSelection(
      selectedProvider,
      customModelsForSelectedProvider,
      draftModel,
    ) as ModelSlug;
  }, [baseThreadModel, composerDraft.model, customModelsForSelectedProvider, selectedProvider]);
  const selectedThreadTitleModel = resolveThreadTitleModel(settings);
  const draftModelOptions = composerDraft.modelOptions;
  const isClaudeUltrathink =
    selectedProvider === "claudeAgent" &&
    supportsClaudeUltrathinkKeyword(selectedModel) &&
    isClaudeUltrathinkPrompt(prompt);
  const selectedModelOptionsForDispatch = useMemo(() => {
    if (selectedProvider === "codex") {
      const codexOptions = normalizeCodexModelOptions(draftModelOptions?.codex);
      return codexOptions ? { codex: codexOptions } : undefined;
    }
    if (selectedProvider === "claudeAgent") {
      const claudeOptions = normalizeClaudeModelOptions(
        selectedModel,
        draftModelOptions?.claudeAgent,
      );
      return claudeOptions ? { claudeAgent: claudeOptions } : undefined;
    }
    return undefined;
  }, [draftModelOptions, selectedModel, selectedProvider]);
  const activeProjectClaudeSettings = useMemo(
    () =>
      getClaudeProjectSettings(
        {
          claudeProjectSettings: settings.claudeProjectSettings,
        },
        activeProject?.id,
      ),
    [activeProject?.id, settings.claudeProjectSettings],
  );
  const providerOptionsForDispatch = useMemo(() => {
    if (selectedProvider === "codex") {
      if (!settings.codexBinaryPath && !settings.codexHomePath) {
        return undefined;
      }

      return {
        codex: {
          ...(settings.codexBinaryPath ? { binaryPath: settings.codexBinaryPath } : {}),
          ...(settings.codexHomePath ? { homePath: settings.codexHomePath } : {}),
        },
      };
    }

    if (selectedProvider === "claudeAgent" && activeProject?.id) {
      const parsedLaunchArgs = parseClaudeLaunchArgs(settings.claudeLaunchArgs);
      if (!parsedLaunchArgs.ok) {
        // The settings page surfaces parse errors inline, but a thread may be
        // started (or restarted) without the page ever being reopened. Emit a
        // console warning so the silent drop is at least discoverable when
        // debugging "my flags aren't being applied".
        console.warn(
          "[ChatView] Ignoring invalid claudeLaunchArgs — open Settings to fix:",
          parsedLaunchArgs.error,
        );
      }
      const launchArgs =
        parsedLaunchArgs.ok && Object.keys(parsedLaunchArgs.args).length > 0
          ? parsedLaunchArgs.args
          : undefined;
      return {
        claudeAgent: {
          ...(settings.claudeBinaryPath ? { binaryPath: settings.claudeBinaryPath } : {}),
          subagentsEnabled: activeProjectClaudeSettings.subagentsEnabled,
          subagentModel: activeProjectClaudeSettings.subagentModel,
          ...(launchArgs ? { launchArgs } : {}),
        },
      };
    }

    return undefined;
  }, [
    activeProject?.id,
    activeProjectClaudeSettings.subagentModel,
    activeProjectClaudeSettings.subagentsEnabled,
    selectedProvider,
    settings.claudeBinaryPath,
    settings.claudeLaunchArgs,
    settings.codexBinaryPath,
    settings.codexHomePath,
  ]);
  const selectedModelForPicker = selectedModel;
  const modelOptionsByProvider = useMemo(
    () => getCustomModelOptionsByProvider(settings),
    [settings],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const showAgentCommandTranscripts = settings.showAgentCommandTranscripts;
  const alwaysExpandAgentCommandTranscripts = settings.alwaysExpandAgentCommandTranscripts;
  const showFileChangeDiffsInline = settings.showFileChangeDiffsInline;
  const threadFileChangesQueryKey = useMemo(
    () => orchestrationQueryKeys.threadFileChanges(threadId),
    [threadId],
  );
  const threadFileChangesQuery = useQuery(
    fullThreadFileChangesQueryOptions({
      threadId,
      enabled: showFileChangeDiffsInline,
    }),
  );
  const commandExecutions = showAgentCommandTranscripts
    ? (activeThread?.commandExecutions ?? EMPTY_COMMAND_EXECUTIONS)
    : EMPTY_COMMAND_EXECUTIONS;
  const fileChangeSummariesById = useMemo<Record<string, OrchestrationFileChangeSummary>>(() => {
    if (!showFileChangeDiffsInline) {
      return {};
    }
    return Object.fromEntries(
      (threadFileChangesQuery.data?.fileChanges ?? []).map((fileChange) => [
        fileChange.id,
        fileChange,
      ]),
    );
  }, [showFileChangeDiffsInline, threadFileChangesQuery.data?.fileChanges]);
  const refreshThreadFileChanges = useCallback(async () => {
    const current =
      queryClient.getQueryData<OrchestrationGetThreadFileChangesResult>(threadFileChangesQueryKey);
    if (!current) {
      await queryClient.fetchQuery(
        fullThreadFileChangesQueryOptions({
          threadId,
          enabled: true,
        }),
      );
      return;
    }

    const result = await fetchThreadFileChangesDelta({
      threadId,
      afterSequenceExclusive: current.latestSequence,
    });
    queryClient.setQueryData<OrchestrationGetThreadFileChangesResult>(
      threadFileChangesQueryKey,
      (existing) => mergeThreadFileChangesResult(existing, result),
    );
  }, [queryClient, threadFileChangesQueryKey, threadId]);
  const onToggleCommandExecution = useCallback((commandExecutionId: string) => {
    setExpandedCommandExecutions((current) => ({
      ...current,
      [commandExecutionId]: !(current[commandExecutionId] ?? false),
    }));
  }, []);
  const onToggleFileChangeDiff = useCallback((workEntryId: string) => {
    setExpandedFileChangeDiffs((current) => ({
      ...current,
      [workEntryId]: !(current[workEntryId] ?? true),
    }));
  }, []);

  const allDirectoriesExpanded = activeThreadId
    ? (changedFilesExpandedByThreadId[activeThreadId] ?? true)
    : true;
  const onToggleAllDirectories = useCallback(() => {
    if (!activeThreadId) return;
    setChangedFilesExpandedForThread(activeThreadId, !allDirectoriesExpanded);
  }, [activeThreadId, allDirectoriesExpanded, setChangedFilesExpandedForThread]);

  useEffect(() => {
    setExpandedCommandExecutions({});
  }, [alwaysExpandAgentCommandTranscripts, threadId]);

  useEffect(() => {
    if (!showFileChangeDiffsInline) {
      return;
    }
    void queryClient.fetchQuery(
      fullThreadFileChangesQueryOptions({
        threadId,
        enabled: true,
      }),
    );
  }, [queryClient, showFileChangeDiffsInline, threadId]);

  useEffect(() => {
    if (!showAgentCommandTranscripts) {
      return;
    }
    setExpandedCommandExecutions((current) => {
      let changed = false;
      const next = { ...current };
      for (const commandExecution of commandExecutions) {
        const shouldExpandByDefault =
          alwaysExpandAgentCommandTranscripts || commandExecution.status === "running";
        if (!shouldExpandByDefault || commandExecution.id in next) {
          continue;
        }
        next[commandExecution.id] = true;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [alwaysExpandAgentCommandTranscripts, commandExecutions, showAgentCommandTranscripts]);
  useEffect(() => {
    if (!showFileChangeDiffsInline) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    return api.orchestration.onDomainEvent((event) => {
      if (event.type === "thread.deleted" && event.payload.threadId === threadId) {
        queryClient.removeQueries({
          queryKey: threadFileChangesQueryKey,
          exact: true,
        });
        queryClient.removeQueries({
          queryKey: orchestrationQueryKeys.threadFileChangePrefix(threadId),
        });
        queryClient.removeQueries({
          queryKey: providerQueryKeys.checkpointDiffPrefix(threadId),
        });
        return;
      }
      if (event.type === "thread.reverted" && event.payload.threadId === threadId) {
        queryClient.removeQueries({
          queryKey: threadFileChangesQueryKey,
          exact: true,
        });
        queryClient.removeQueries({
          queryKey: orchestrationQueryKeys.threadFileChangePrefix(threadId),
        });
        queryClient.removeQueries({
          queryKey: providerQueryKeys.checkpointDiffPrefix(threadId),
        });
        void queryClient.fetchQuery(
          fullThreadFileChangesQueryOptions({
            threadId,
            enabled: true,
          }),
        );
        return;
      }
      if (event.type === "thread.turn-diff-completed" && event.payload.threadId === threadId) {
        void queryClient.invalidateQueries({
          queryKey: providerQueryKeys.checkpointDiffPrefix(threadId),
        });
        return;
      }
      if (event.type === "thread.file-change-recorded" && event.payload.threadId === threadId) {
        void refreshThreadFileChanges().catch((error) => {
          console.warn("Failed to refresh thread file-change transcripts from domain event", {
            threadId,
            error,
          });
        });
        void queryClient.invalidateQueries({
          queryKey: orchestrationQueryKeys.threadFileChange(threadId, event.payload.fileChange.id),
          exact: true,
        });
      }
    });
  }, [
    queryClient,
    refreshThreadFileChanges,
    showFileChangeDiffsInline,
    threadFileChangesQueryKey,
    threadId,
  ]);
  const canCompactConversation =
    activeThread !== undefined &&
    (activeThread.messages.length > 1 || activeThread.activities.length > 0);
  const nowIso = new Date(nowTick).toISOString();
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const threadTasks = activeThread?.tasks ?? EMPTY_TASKS;
  const latestConfiguredRuntimeActivity = useMemo(() => {
    for (let index = threadActivities.length - 1; index >= 0; index -= 1) {
      const activity = threadActivities[index];
      if (!activity || activity.kind !== "runtime.configured") {
        continue;
      }
      const payload = readRuntimeConfiguredPayload(activity.payload);
      if (payload) {
        return payload;
      }
    }
    return null;
  }, [threadActivities]);
  const latestModelRerouteActivity = useMemo(() => {
    for (let index = threadActivities.length - 1; index >= 0; index -= 1) {
      const activity = threadActivities[index];
      if (!activity || activity.kind !== "runtime.model-rerouted") {
        continue;
      }
      return activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    }

    return null;
  }, [threadActivities]);
  const mcpRuntimeSummary = useMemo(() => {
    const latestStatusByServer = new Map<string, ReturnType<typeof readMcpStatusActivityPayload>>();

    for (const activity of threadActivities) {
      if (activity.kind !== "mcp.status.updated") {
        continue;
      }
      const payload = readMcpStatusActivityPayload(activity.payload);
      if (!payload) {
        continue;
      }
      latestStatusByServer.set(payload.name ?? "__unnamed__", payload);
    }

    if (latestStatusByServer.size === 0) {
      return null;
    }

    let connectedCount = 0;
    for (const status of latestStatusByServer.values()) {
      if (status?.status === "ready") {
        connectedCount += 1;
      }
    }

    return `${connectedCount}/${latestStatusByServer.size} connected`;
  }, [threadActivities]);
  const workLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined, {
        runtimeWarningVisibility: settings.runtimeWarningVisibility,
        suppressCommandToolLifecycle: showAgentCommandTranscripts && commandExecutions.length > 0,
      }),
    [
      activeLatestTurn?.turnId,
      commandExecutions.length,
      settings.runtimeWarningVisibility,
      showAgentCommandTranscripts,
      threadActivities,
    ],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () =>
      deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined, {
        tasks: threadTasks,
        turnId: activeThread?.tasksTurnId ?? null,
        updatedAt: activeThread?.tasksUpdatedAt ?? null,
      }),
    [
      activeLatestTurn?.turnId,
      activeThread?.tasksTurnId,
      activeThread?.tasksUpdatedAt,
      threadActivities,
      threadTasks,
    ],
  );
  const effectiveThreadTasks = useMemo(
    () => (threadTasks.length > 0 ? threadTasks : deriveFallbackTasksFromPlan(activePlan)),
    [activePlan, threadTasks],
  );
  const hasIncompleteThreadTasks = useMemo(
    () => effectiveThreadTasks.some((task) => task.status !== "completed"),
    [effectiveThreadTasks],
  );
  const taskPanelSummary = useMemo(
    () => summarizeTaskCounts(effectiveThreadTasks),
    [effectiveThreadTasks],
  );
  useEffect(() => {
    const activeThreadId = activeThread?.id ?? null;
    const threadChanged = previousTaskPanelThreadIdRef.current !== activeThreadId;
    const trackedTaskCount = effectiveThreadTasks.length;
    const trackedTasksAppeared = previousThreadTaskCountRef.current === 0 && trackedTaskCount > 0;

    if (threadChanged) {
      tasksPanelManuallyCollapsedRef.current = false;
      setTasksPanelOpen(trackedTaskCount > 0 && hasIncompleteThreadTasks);
    } else if (trackedTaskCount === 0) {
      tasksPanelManuallyCollapsedRef.current = false;
      setTasksPanelOpen(false);
    } else if (
      trackedTasksAppeared &&
      hasIncompleteThreadTasks &&
      !tasksPanelManuallyCollapsedRef.current
    ) {
      setTasksPanelOpen(true);
    }

    previousTaskPanelThreadIdRef.current = activeThreadId;
    previousThreadTaskCountRef.current = trackedTaskCount;
  }, [activeThread?.id, effectiveThreadTasks.length, hasIncompleteThreadTasks]);
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const recoveryEpoch = useRecoveryStateStore((store) => store.recoveryEpoch);
  const serverAcknowledgedPendingTurnDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch: pendingTurnDispatch?.localDispatch ?? null,
        phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingUserInput: activePendingUserInput !== null,
        threadError: activeThread?.error,
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.session,
      pendingTurnDispatch?.localDispatch,
      phase,
    ],
  );
  const hasPendingTurnDispatch = pendingTurnDispatch !== null;
  const isPendingTurnDispatchBlocked = hasPendingTurnDispatch;
  const pendingTurnDispatchAwaitingUserAction =
    pendingTurnDispatch?.status === "awaiting-user-action";
  const isPreparingWorktree = pendingTurnDispatch?.preparingWorktree ?? false;
  const localDispatchStartedAt = pendingTurnDispatch?.localDispatch.startedAt ?? null;
  const isSendBusy =
    pendingTurnDispatch !== null && pendingTurnDispatch.status !== "awaiting-user-action";
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = useMemo(
    () =>
      deriveActiveWorkStartedAt(
        activeLatestTurn,
        activeThread?.session ?? null,
        localDispatchStartedAt,
      ),
    [activeLatestTurn, activeThread?.session, localDispatchStartedAt],
  );
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        commandExecutions,
      ),
    [activeThread?.proposedPlans, commandExecutions, timelineMessages, workLogEntries],
  );
  const shouldRenderTimeline = shouldRenderTimelineContent({
    detailsLoaded: activeThread?.detailsLoaded ?? false,
    hasRenderableMessage: timelineMessages.length > 0,
  });
  useEffect(() => {
    if (!activeThread?.detailsLoaded || !shouldRenderTimeline) {
      return;
    }
    finishThreadOpenTrace(activeThread.id, "timeline-visible", {
      timelineEntryCount: timelineEntries.length,
      messageCount: activeThread.messages.length,
      checkpointCount: activeThread.turnDiffSummaries.length,
    });
  }, [
    activeThread?.detailsLoaded,
    activeThread?.id,
    activeThread?.messages.length,
    activeThread?.turnDiffSummaries.length,
    shouldRenderTimeline,
    timelineEntries.length,
  ]);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const activeThreadHistory = ensureThreadHistoryState(activeThread?.history);
  const historyStatusContent =
    activeThread && activeThreadHistory.stage === "backfilling" ? (
      <div className="mx-auto mb-4 w-full max-w-3xl rounded-2xl border border-border/70 bg-card/70 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur-sm">
        Loading earlier messages...
      </div>
    ) : activeThread && activeThreadHistory.stage === "error" ? (
      <div className="mx-auto mb-4 flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/70 px-4 py-3 shadow-sm backdrop-blur-sm">
        <p className="text-sm text-muted-foreground">Retry loading earlier messages.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void retryThreadHistoryBackfill(queryClient, activeThread.id);
          }}
        >
          Retry
        </Button>
      </div>
    ) : null;
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const turnDiffSummaryByTurnId = useMemo(() => {
    const byTurnId = new Map<TurnId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      byTurnId.set(summary.turnId, summary);
    }
    return byTurnId;
  }, [turnDiffSummaries]);
  const diffFilePathsByTurnId = useMemo(() => {
    const pathsByTurnId = new Map<TurnId, Set<string>>();
    for (const summary of turnDiffSummaries) {
      const filePaths = new Set<string>();
      for (const file of summary.files) {
        filePaths.add(file.path);
      }
      pathsByTurnId.set(summary.turnId, filePaths);
    }
    return pathsByTurnId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!completionSummary) return null;

    const turnStartedAt = Date.parse(activeLatestTurn.startedAt);
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnStartedAt)) return null;
    if (Number.isNaN(turnCompletedAt)) return null;

    let inRangeMatch: string | null = null;
    let fallbackMatch: string | null = null;
    for (const timelineEntry of timelineEntries) {
      if (timelineEntry.kind !== "message") continue;
      if (timelineEntry.message.role !== "assistant") continue;
      const messageAt = Date.parse(timelineEntry.message.createdAt);
      if (Number.isNaN(messageAt) || messageAt < turnStartedAt) continue;
      fallbackMatch = timelineEntry.id;
      if (messageAt <= turnCompletedAt) {
        inRangeMatch = timelineEntry.id;
      }
    }
    return inRangeMatch ?? fallbackMatch;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    completionSummary,
    latestTurnSettled,
    timelineEntries,
  ]);
  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const branchesQuery = useQuery(
    gitBranchesQueryOptions({
      cwd: gitCwd,
      autoRefresh: settings.enableGitStatusAutoRefresh,
    }),
  );
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (composerTrigger.kind === "slash-command") {
      return buildSlashComposerMenuItems({
        query: composerTrigger.query,
        runtimeSlashCommands: latestConfiguredRuntimeActivity?.slashCommands,
        provider: selectedProvider,
        projectSkills: activeProject?.skills,
      });
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model",
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [
    activeProject?.skills,
    composerTrigger,
    latestConfiguredRuntimeActivity?.slashCommands,
    searchableModelOptions,
    selectedProvider,
    workspaceEntries,
  ]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const providerStatuses = serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES;
  const activeProvider = activeThread?.session?.provider ?? "codex";
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === activeProvider) ?? null,
    [activeProvider, providerStatuses],
  );
  const activeProviderStatusKey = activeProviderStatus
    ? `${activeProviderStatus.provider}:${activeProviderStatus.status}:${activeProviderStatus.message ?? ""}`
    : null;
  const [dismissedProviderStatusKey, setDismissedProviderStatusKey] = useLocalStorage(
    DISMISSED_PROVIDER_STATUS_KEY,
    null as string | null,
    DismissedProviderStatusSchema,
  );
  const isProviderStatusDismissed =
    activeProviderStatusKey !== null && dismissedProviderStatusKey === activeProviderStatusKey;
  const providerRuntimeInfoEntries = useMemo(() => {
    return deriveProviderRuntimeInfoEntries({
      provider: sessionProvider ?? selectedProviderByThreadId ?? null,
      threadModel: activeThread?.model ?? null,
      configuredRuntime: latestConfiguredRuntimeActivity,
      rerouteActivity: latestModelRerouteActivity,
      cliVersion: activeProviderStatus?.version ?? null,
      mcpSummary: mcpRuntimeSummary,
    });
  }, [
    activeProviderStatus?.version,
    activeThread?.model,
    latestConfiguredRuntimeActivity,
    latestModelRerouteActivity,
    mcpRuntimeSummary,
    selectedProviderByThreadId,
    sessionProvider,
  ]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = branchesQuery.data?.isRepo ?? true;
  const onOpenFileChangeDiff = useCallback(
    (fileChangeId: OrchestrationFileChangeId, filePath?: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = clearDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffFileChangeId: fileChangeId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffFileChangeId: fileChangeId };
        },
      });
    },
    [navigate, threadId],
  );
  const chatDiffContext = useMemo<ChatDiffContext>(
    () => ({
      threadId: activeThread?.id ?? null,
      isGitRepo: branchesQuery.data?.isRepo === true,
      inferredCheckpointTurnCountByTurnId,
      expandedFileChangeDiffs,
      fileChangeSummariesById,
      onToggleFileChangeDiff,
      onOpenFileChangeDiff,
    }),
    [
      activeThread?.id,
      branchesQuery.data?.isRepo,
      expandedFileChangeDiffs,
      fileChangeSummariesById,
      inferredCheckpointTurnCountByTurnId,
      onToggleFileChangeDiff,
      onOpenFileChangeDiff,
    ],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const scrollToBottomShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.scrollToBottom"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = clearDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, navigate, threadId]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      if (threads.some((thread) => thread.id === targetThreadId)) {
        setStoreThreadError(targetThreadId, nextError);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: nextError,
        };
      });
    },
    [setStoreThreadError, threads],
  );

  const focusComposer = useCallback(() => {
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (pendingTurnDispatchRef.current) {
        return;
      }
      if (!activeThread) {
        return;
      }
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [activeThread, composerCursor, composerTerminalContexts, insertComposerDraftTerminalContext],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (!isServerThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd =
        options?.cwd ??
        projectScriptCwd({
          project: { cwd: activeProject.cwd },
          worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        });
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: Parameters<typeof api.terminal.open>[0] = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      isServerThread,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (isPendingTurnDispatchBlocked) return;
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isPendingTurnDispatchBlocked,
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (isPendingTurnDispatchBlocked) return;
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isPendingTurnDispatchBlocked,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const toggleRuntimeMode = useCallback(() => {
    void handleRuntimeModeChange(
      runtimeMode === "full-access" ? "approval-required" : "full-access",
    );
  }, [handleRuntimeModeChange, runtimeMode]);
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        const turnKey = activePlan?.turnId ?? activeProposedPlan?.turnId ?? null;
        if (turnKey) {
          planSidebarDismissedForTurnRef.current = turnKey;
        }
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlan?.turnId, activeProposedPlan?.turnId]);
  const closePlanSidebar = useCallback(() => {
    setPlanSidebarOpen(false);
    const turnKey = activePlan?.turnId ?? activeProposedPlan?.turnId ?? null;
    if (turnKey) {
      planSidebarDismissedForTurnRef.current = turnKey;
    }
  }, [activePlan?.turnId, activeProposedPlan?.turnId]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      model?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (input.model !== undefined && input.model !== serverThread.model) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          model: input.model,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );

  // LegendList owns scroll state now; we keep a footer-resize observer only
  // to drive the compact composer footer layout (no scroll side effects).
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;

    setIsComposerFooterCompact(
      shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      }),
    );
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompact = shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions]);

  useEffect(() => {
    setExpandedWorkGroups({});
    setExpandedFileChangeDiffs({});
    setPullRequestDialogState(null);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
    // maintainScrollAtEnd + initialScrollAtEnd handle thread-switch pinning;
    // reset the pill-visibility state so we don't briefly flash stale state.
    isAtEndRef.current = true;
    showScrollDebouncer.current?.cancel();
    setShowScrollToBottom(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerFilePathsRef.current = composerFilePaths;
  }, [composerFilePaths]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  useEffect(() => {
    if (phase !== "running" && !isSendBusy) return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isSendBusy, phase]);

  const removeOptimisticMessage = useCallback((messageId: MessageId) => {
    setOptimisticUserMessages((existing) => {
      const removedMessages = existing.filter((message) => message.id === messageId);
      if (removedMessages.length === 0) {
        return existing;
      }
      for (const message of removedMessages) {
        revokeUserMessagePreviewUrls(message);
      }
      return existing.filter((message) => message.id !== messageId);
    });
  }, []);

  const composerMatchesClearedState = useCallback(
    () =>
      promptRef.current.length === 0 &&
      composerImagesRef.current.length === 0 &&
      composerFilePathsRef.current.length === 0 &&
      composerTerminalContextsRef.current.length === 0,
    [],
  );

  const restoreComposerRollback = useCallback(
    (rollback: PendingTurnDispatchRollback) => {
      const restoredImages = rollback.images.map(cloneComposerImageForRetry);
      promptRef.current = rollback.prompt;
      setPrompt(rollback.prompt);
      setComposerCursor(collapseExpandedComposerCursor(rollback.prompt, rollback.prompt.length));
      setComposerTrigger(detectComposerTrigger(rollback.prompt, rollback.prompt.length));
      setComposerDraftFilePaths(threadId, rollback.filePaths);
      addComposerImagesToDraft(restoredImages);
      setComposerDraftTerminalContexts(threadId, rollback.terminalContexts);
      setComposerDraftInteractionMode(threadId, rollback.interactionMode);
      if (draftThread) {
        setDraftThreadContext(threadId, { interactionMode: rollback.interactionMode });
      }
      setComposerHighlightedItemId(null);
      window.requestAnimationFrame(() => {
        focusComposer();
      });
    },
    [
      addComposerImagesToDraft,
      setComposerDraftFilePaths,
      draftThread,
      focusComposer,
      setComposerDraftInteractionMode,
      setComposerDraftTerminalContexts,
      setDraftThreadContext,
      setPrompt,
      threadId,
    ],
  );

  const clearPendingTurnDispatchArtifacts = useCallback(
    (
      commandId?: CommandId | null,
      options?: {
        preserveRollbackImages?: boolean;
      },
    ) => {
      if (commandId) {
        const artifacts = getPendingTurnDispatchArtifacts(commandId);
        if (!artifacts) {
          return;
        }
        if (!options?.preserveRollbackImages) {
          revokeComposerImagePreviewUrls(artifacts.rollback.images);
        }
        deletePendingTurnDispatchArtifacts(commandId);
        return;
      }

      for (const artifacts of listPendingTurnDispatchArtifacts()) {
        if (!options?.preserveRollbackImages) {
          revokeComposerImagePreviewUrls(artifacts.rollback.images);
        }
        deletePendingTurnDispatchArtifacts(artifacts.command.commandId);
      }
    },
    [],
  );

  const clearPendingTurnDispatch = useCallback(
    (options?: { commandId?: CommandId | null; preserveRollbackImages?: boolean }) => {
      const commandId = options?.commandId ?? pendingTurnDispatchRef.current?.commandId ?? null;
      clearPendingTurnDispatchArtifacts(
        commandId,
        options?.preserveRollbackImages === undefined
          ? undefined
          : { preserveRollbackImages: options.preserveRollbackImages },
      );
      updateStorePendingTurnDispatch(threadId, (current) => {
        if (!current) {
          return current;
        }
        if (options?.commandId && current.commandId !== options.commandId) {
          return current;
        }
        return null;
      });
    },
    [clearPendingTurnDispatchArtifacts, threadId, updateStorePendingTurnDispatch],
  );

  const beginPendingTurnDispatch = useCallback(
    (input: {
      command: PendingTurnStartCommand;
      rollback: PendingTurnDispatchRollback;
      preparingWorktree: boolean;
      localDispatch: ReturnType<typeof createLocalDispatchSnapshot>;
    }) => {
      setPendingTurnDispatchArtifacts(input.command.commandId, {
        command: input.command,
        rollback: input.rollback,
      });
      const nextPendingTurnDispatch: PendingTurnDispatch = {
        status: "dispatching",
        commandId: input.command.commandId,
        messageId: input.command.message.messageId,
        optimisticMessageId: input.command.message.messageId,
        createdAt: input.command.createdAt,
        preparingWorktree: input.preparingWorktree,
        localDispatch: input.localDispatch,
        acceptedSequence: null,
        awaitingRecoveryAfterEpoch: null,
        lastResolvedRecoveryEpoch: null,
      };
      setStorePendingTurnDispatch(input.command.threadId, nextPendingTurnDispatch);
      return nextPendingTurnDispatch;
    },
    [setStorePendingTurnDispatch],
  );

  const dispatchPendingTurnStartCommand = useCallback(
    async (input: {
      api: NativeApiClient;
      command: PendingTurnStartCommand;
      rollback: PendingTurnDispatchRollback;
      preparingWorktree: boolean;
      localDispatch: ReturnType<typeof createLocalDispatchSnapshot>;
      failureMessage: string;
      onNonTransportFailure?: (message: string, rollback: PendingTurnDispatchRollback) => void;
    }) => {
      const existingPending = pendingTurnDispatchRef.current;
      if (existingPending?.commandId === input.command.commandId) {
        setPendingTurnDispatchArtifacts(input.command.commandId, {
          command: input.command,
          rollback: input.rollback,
        });
        setStorePendingTurnDispatch(input.command.threadId, {
          ...existingPending,
          status: "dispatching",
          preparingWorktree: input.preparingWorktree,
          localDispatch: input.localDispatch,
          awaitingRecoveryAfterEpoch: null,
        });
      } else {
        beginPendingTurnDispatch(input);
      }

      try {
        const result = await input.api.orchestration.dispatchCommand(input.command);
        updateStorePendingTurnDispatch(input.command.threadId, (current) => {
          if (!current || current.commandId !== input.command.commandId) {
            return current;
          }
          return {
            ...current,
            acceptedSequence: result.sequence,
          };
        });
        return { ok: true as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : input.failureMessage;
        if (isTransportConnectionErrorMessage(message)) {
          updateStorePendingTurnDispatch(input.command.threadId, (current) => {
            if (!current || current.commandId !== input.command.commandId) {
              return current;
            }
            return {
              ...current,
              status: "awaiting-recovery",
              awaitingRecoveryAfterEpoch: recoveryEpoch,
            };
          });
          setThreadError(input.command.threadId, message);
          return { ok: false as const, transportFailure: true as const };
        }

        clearPendingTurnDispatch({ commandId: input.command.commandId });
        input.onNonTransportFailure?.(message, input.rollback);
        return { ok: false as const, transportFailure: false as const };
      }
    },
    [
      beginPendingTurnDispatch,
      clearPendingTurnDispatch,
      recoveryEpoch,
      setStorePendingTurnDispatch,
      setThreadError,
      updateStorePendingTurnDispatch,
    ],
  );

  useEffect(() => {
    if (!pendingTurnDispatch) {
      return;
    }
    const messageAccepted = activeThread?.messages.some(
      (message) => message.id === pendingTurnDispatch.messageId,
    );
    if (!messageAccepted && !serverAcknowledgedPendingTurnDispatch) {
      return;
    }

    clearPendingTurnDispatch();
    const activeThreadError = activeThread?.error ?? localDraftErrorsByThreadId[threadId] ?? null;
    if (isTransportConnectionErrorMessage(activeThreadError)) {
      setThreadError(threadId, null);
    }
  }, [
    activeThread?.error,
    activeThread?.messages,
    clearPendingTurnDispatch,
    localDraftErrorsByThreadId,
    pendingTurnDispatch,
    serverAcknowledgedPendingTurnDispatch,
    setThreadError,
    threadId,
  ]);

  useEffect(() => {
    if (
      !pendingTurnDispatch ||
      pendingTurnDispatch.status !== "awaiting-recovery" ||
      pendingTurnDispatch.awaitingRecoveryAfterEpoch === null ||
      recoveryEpoch <= pendingTurnDispatch.awaitingRecoveryAfterEpoch ||
      pendingTurnDispatch.lastResolvedRecoveryEpoch === recoveryEpoch
    ) {
      return;
    }

    const messageAccepted = activeThread?.messages.some(
      (message) => message.id === pendingTurnDispatch.messageId,
    );
    if (messageAccepted || serverAcknowledgedPendingTurnDispatch) {
      clearPendingTurnDispatch();
      const activeThreadError = activeThread?.error ?? localDraftErrorsByThreadId[threadId] ?? null;
      if (isTransportConnectionErrorMessage(activeThreadError)) {
        setThreadError(threadId, null);
      }
      return;
    }

    updateStorePendingTurnDispatch(threadId, (current) => {
      if (!current || current.commandId !== pendingTurnDispatch.commandId) {
        return current;
      }
      return {
        ...current,
        status: "awaiting-user-action",
        lastResolvedRecoveryEpoch: recoveryEpoch,
      };
    });
  }, [
    activeThread?.error,
    activeThread?.messages,
    clearPendingTurnDispatch,
    localDraftErrorsByThreadId,
    pendingTurnDispatch,
    recoveryEpoch,
    serverAcknowledgedPendingTurnDispatch,
    setThreadError,
    threadId,
    updateStorePendingTurnDispatch,
  ]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      if (wsInteractionBlocked) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: Boolean(terminalState.terminalOpen),
        },
      });
      if (command !== "chat.scrollToBottom") return;

      const composerForm = composerFormRef.current;
      const eventTarget = event.target instanceof Node ? event.target : null;
      const activeElement = document.activeElement;
      const composerFocused = Boolean(
        composerForm &&
        ((eventTarget && composerForm.contains(eventTarget)) ||
          (activeElement instanceof Node && composerForm.contains(activeElement))),
      );

      if (showScrollToBottom) {
        event.preventDefault();
        event.stopPropagation();
        scrollToEnd(true);
        return;
      }

      if (!composerFocused) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeThreadId,
    keybindings,
    scrollToEnd,
    showScrollToBottom,
    terminalState.terminalOpen,
    wsInteractionBlocked,
  ]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      if (wsInteractionBlocked) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    toggleTerminalVisibility,
    wsInteractionBlocked,
  ]);

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (isPendingTurnDispatchBlocked) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const addComposerFileAttachments = (files: File[]) => {
    if (!activeThreadId || !activeProject || files.length === 0) return;
    if (isPendingTurnDispatchBlocked) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach files after answering plan questions.",
      });
      return;
    }

    const workspaceRoots = [activeThread?.worktreePath, activeProject.cwd];
    const normalizeAbsolutePathForComparison = createCachedAbsolutePathComparisonNormalizer(
      window.desktopBridge?.resolveRealPath ?? identityAbsolutePathNormalizer,
    );
    const {
      filePaths: paths,
      missingPathCount,
      invalidPathCount,
    } = resolveAttachedFileReferencePaths({
      files,
      isElectron,
      desktopBridge: window.desktopBridge,
      workspaceRoots,
      normalizeAbsolutePathForComparison,
    });

    if (paths.length > 0) {
      addComposerFilePathsToDraft(paths);
    }

    const warnings: string[] = [];
    if (missingPathCount > 0) {
      warnings.push("File attachments require the desktop app to resolve filesystem paths.");
    }
    if (invalidPathCount > 0) {
      warnings.push("Some file attachments could not be added.");
    }
    for (const warning of warnings) {
      toastManager.add({
        type: "warning",
        title: warning,
      });
    }
  };

  const removeComposerImage = (imageId: string) => {
    if (isPendingTurnDispatchBlocked) {
      return;
    }
    removeComposerImageFromDraft(imageId);
  };

  const removeComposerFilePath = (filePath: string) => {
    if (isPendingTurnDispatchBlocked) {
      return;
    }
    removeComposerFilePathFromDraft(filePath);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const nonImageFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (imageFiles.length > 0) {
      event.preventDefault();
      addComposerImages(imageFiles);
    }
    if (nonImageFiles.length > 0 && isElectron) {
      addComposerFileAttachments(nonImageFiles);
      event.preventDefault();
    }
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const nonImageFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (imageFiles.length > 0) {
      addComposerImages(imageFiles);
    }
    if (nonImageFiles.length > 0) {
      addComposerFileAttachments(nonImageFiles);
    }
    focusComposer();
  };

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (hasPendingTurnDispatch) {
        setThreadError(activeThread.id, "Resolve the pending send before reverting checkpoints.");
        return;
      }
      if (phase === "running" || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      hasPendingTurnDispatch,
      isConnecting,
      isRevertingCheckpoint,
      phase,
      setThreadError,
    ],
  );

  const onCompactConversation = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) {
      return;
    }

    if (hasPendingTurnDispatch) {
      setThreadError(
        activeThread.id,
        "Resolve the pending send before compacting the conversation.",
      );
      return;
    }
    if (phase === "running" || isConnecting || isRevertingCheckpoint) {
      setThreadError(
        activeThread.id,
        "Interrupt the current turn before compacting the conversation.",
      );
      return;
    }

    setThreadError(activeThread.id, null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.compact.request",
        commandId: newCommandId(),
        threadId: activeThread.id,
        trigger: "manual",
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      setThreadError(
        activeThread.id,
        err instanceof Error ? err.message : "Failed to compact the conversation.",
      );
    }
  }, [
    activeThread,
    hasPendingTurnDispatch,
    isConnecting,
    isRevertingCheckpoint,
    phase,
    setThreadError,
  ]);

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      hasPendingTurnDispatch ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      filePathCount: composerFilePaths.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      composerFilePaths.length === 0 &&
      sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      await handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    // Always request worktree preparation on the first send in worktree mode,
    // even if the client cache shows a non-null `worktreePath`. The client
    // cache can be stale after preload/restore, and the server has the
    // authoritative state — it will skip worktree creation idempotently when
    // the thread's read-model already has a worktree. Previously we only
    // requested preparation when `!activeThread.worktreePath`, which meant a
    // stale cached value silently skipped worktree creation and caused the
    // agent to run in the project root (main branch).
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" ? activeThread.branch : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree = isFirstMessage && envMode === "worktree";
    if (shouldCreateWorktree && !activeThread.branch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return;
    }

    sendInFlightRef.current = true;
    const preparingWorktree = Boolean(baseBranchForWorktree);

    const composerImagesSnapshot = [...composerImages];
    const normalizeAbsolutePathForComparison = createCachedAbsolutePathComparisonNormalizer(
      window.desktopBridge?.resolveRealPath ?? identityAbsolutePathNormalizer,
    );
    const { filePaths: composerFilePathsSnapshot, invalidPathCount: invalidComposerFilePathCount } =
      sanitizeAttachedFileReferencePaths({
        filePaths: composerFilePaths,
        workspaceRoots: [activeThread.worktreePath, activeProject.cwd],
        normalizeAbsolutePathForComparison,
      });
    if (invalidComposerFilePathCount > 0) {
      toastManager.add({
        type: "error",
        title: "Remove or reattach invalid file attachments before sending.",
      });
      sendInFlightRef.current = false;
      return;
    }
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const rollback: PendingTurnDispatchRollback = {
      prompt: promptForSend,
      images: composerImagesSnapshot.map(cloneComposerImageForRetry),
      filePaths: composerFilePathsSnapshot,
      terminalContexts: composerTerminalContextsSnapshot,
      interactionMode,
    };
    const rewrittenPromptForSend = rewriteComposerRuntimeSkillInvocationForSend({
      text: promptForSend,
      provider: selectedProvider,
      runtimeSlashCommands: latestConfiguredRuntimeActivity?.slashCommands,
    });
    // Rewrite provider-specific runtime skill syntax before any send-time
    // context helpers append extra text ahead of the user's leading token.
    const messageTextWithContexts = appendTerminalContextsToPrompt(
      rewrittenPromptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageTextForSend = appendAttachedFilesToPrompt(
      messageTextWithContexts,
      composerFilePathsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT;
    const titleSourceText =
      trimmed.length > 0
        ? trimmed
        : composerFilePathsSnapshot[0]
          ? basenameOfPath(composerFilePathsSnapshot[0])
          : trimmed;
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    // Let the list preserve the current viewport across optimistic sends.
    // Manual pin-to-end here scrolls historical file-change rows out of view
    // right when the next user message is appended.
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: messageTextForSend,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(threadIdForSend);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);

    const restoreDraftAfterFailure = (
      message: string,
      failureRollback: PendingTurnDispatchRollback,
    ) => {
      removeOptimisticMessage(messageIdForSend);
      if (composerMatchesClearedState()) {
        restoreComposerRollback(failureRollback);
      }
      setThreadError(threadIdForSend, message);
    };

    try {
      const bootstrap = buildFirstSendBootstrap({
        isLocalDraftThread,
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        projectModel: activeProject.model,
        projectScripts: activeProject.scripts,
        selectedModel,
        runtimeMode,
        interactionMode,
        thread: {
          branch: activeThread.branch,
          worktreePath: activeThread.worktreePath,
          createdAt: activeThread.createdAt,
        },
        baseBranchForWorktree,
      });

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode,
          interactionMode,
        });
      }

      const turnAttachments = await turnAttachmentsPromise;
      const command: PendingTurnStartCommand = {
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        model: selectedModel || undefined,
        titleGenerationModel: selectedThreadTitleModel,
        titleSourceText,
        ...(selectedModelOptionsForDispatch
          ? { modelOptions: selectedModelOptionsForDispatch }
          : {}),
        ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
        provider: selectedProvider,
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
        runtimeMode,
        interactionMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      };
      const localDispatch = createLocalDispatchSnapshot(activeThread, { preparingWorktree });
      await dispatchPendingTurnStartCommand({
        api,
        command,
        rollback,
        preparingWorktree,
        localDispatch,
        failureMessage: "Failed to send message.",
        onNonTransportFailure: restoreDraftAfterFailure,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send message.";
      restoreDraftAfterFailure(message, rollback);
    } finally {
      sendInFlightRef.current = false;
    }
  };

  const onInterrupt = async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: {
            selectedOptionLabels: [optionLabel],
            customAnswer: "",
          },
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onToggleActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: togglePendingUserInputOption(
            existing[activePendingUserInput.requestId]?.[questionId],
            optionLabel,
          ),
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        hasPendingTurnDispatch ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = rewriteComposerRuntimeSkillInvocationForSend({
        text: trimmed,
        provider: selectedProvider,
        runtimeSlashCommands: latestConfiguredRuntimeActivity?.slashCommands,
      });
      const rollback: PendingTurnDispatchRollback = {
        prompt: promptRef.current,
        images: composerImagesRef.current.map(cloneComposerImageForRetry),
        filePaths: [...composerFilePathsRef.current],
        terminalContexts: [...composerTerminalContextsRef.current],
        interactionMode,
      };

      sendInFlightRef.current = true;
      setThreadError(threadIdForSend, null);
      // Let the list preserve the current viewport across optimistic follow-up
      // sends instead of forcing the tail into view immediately.
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      promptRef.current = "";
      clearComposerDraftContent(threadIdForSend);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);
        const command: PendingTurnStartCommand = {
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          provider: selectedProvider,
          model: selectedModel || undefined,
          titleGenerationModel: selectedThreadTitleModel,
          titleSourceText: trimmed,
          ...(selectedModelOptionsForDispatch
            ? { modelOptions: selectedModelOptionsForDispatch }
            : {}),
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        };
        const localDispatch = createLocalDispatchSnapshot(activeThread);
        await dispatchPendingTurnStartCommand({
          api,
          command,
          rollback,
          preparingWorktree: false,
          localDispatch,
          failureMessage: "Failed to send plan follow-up.",
          onNonTransportFailure: (message, failureRollback) => {
            removeOptimisticMessage(messageIdForSend);
            if (composerMatchesClearedState()) {
              restoreComposerRollback(failureRollback);
            } else {
              setComposerDraftInteractionMode(threadIdForSend, failureRollback.interactionMode);
              if (draftThread) {
                setDraftThreadContext(threadIdForSend, {
                  interactionMode: failureRollback.interactionMode,
                });
              }
            }
            setThreadError(threadIdForSend, message);
          },
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to send plan follow-up.";
        removeOptimisticMessage(messageIdForSend);
        if (composerMatchesClearedState()) {
          restoreComposerRollback(rollback);
        } else {
          setComposerDraftInteractionMode(threadIdForSend, rollback.interactionMode);
          if (draftThread) {
            setDraftThreadContext(threadIdForSend, {
              interactionMode: rollback.interactionMode,
            });
          }
        }
        setThreadError(threadIdForSend, message);
      } finally {
        sendInFlightRef.current = false;
      }
    },
    [
      activeThread,
      activeProposedPlan,
      clearComposerDraftContent,
      composerMatchesClearedState,
      dispatchPendingTurnStartCommand,
      draftThread,
      hasPendingTurnDispatch,
      isConnecting,
      isServerThread,
      latestConfiguredRuntimeActivity?.slashCommands,
      persistThreadSettingsForNextTurn,
      removeOptimisticMessage,
      restoreComposerRollback,
      runtimeMode,
      selectedModel,
      selectedThreadTitleModel,
      selectedModelOptionsForDispatch,
      providerOptionsForDispatch,
      selectedProvider,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      setThreadError,
      settings.enableAssistantStreaming,
      interactionMode,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      hasPendingTurnDispatch ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = implementationPrompt;
    const nextThreadTitle = normalizeGeneratedThreadTitle(
      buildPlanImplementationThreadTitle(planMarkdown),
    );
    const nextThreadModel: ModelSlug =
      selectedModel ||
      (activeThread.model as ModelSlug) ||
      (activeProject.model as ModelSlug) ||
      DEFAULT_MODEL_BY_PROVIDER.codex;

    sendInFlightRef.current = true;
    const finish = () => {
      sendInFlightRef.current = false;
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        model: nextThreadModel,
        runtimeMode,
        interactionMode: "default",
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          provider: selectedProvider,
          model: selectedModel || undefined,
          titleGenerationModel: selectedThreadTitleModel,
          titleSourceText: outgoingImplementationPrompt,
          ...(selectedModelOptionsForDispatch
            ? { modelOptions: selectedModelOptionsForDispatch }
            : {}),
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
          runtimeMode,
          interactionMode: "default",
          createdAt,
        });
      })
      .then(() => api.orchestration.getSnapshot())
      .then((snapshot) => {
        syncServerReadModel(snapshot);
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        await api.orchestration
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    hasPendingTurnDispatch,
    isConnecting,
    isServerThread,
    navigate,
    runtimeMode,
    selectedModel,
    selectedThreadTitleModel,
    selectedModelOptionsForDispatch,
    providerOptionsForDispatch,
    selectedProvider,
    settings.enableAssistantStreaming,
    syncServerReadModel,
  ]);

  const onRetryPendingTurnDispatch = useCallback(async () => {
    const api = readNativeApi();
    const pending = pendingTurnDispatchRef.current;
    if (!api || !pending || sendInFlightRef.current) {
      return;
    }
    const artifacts = getPendingTurnDispatchArtifacts(pending.commandId);
    if (!artifacts) {
      clearPendingTurnDispatch({ commandId: pending.commandId });
      return;
    }

    sendInFlightRef.current = true;
    setThreadError(artifacts.command.threadId, null);
    try {
      await dispatchPendingTurnStartCommand({
        api,
        command: artifacts.command,
        rollback: artifacts.rollback,
        preparingWorktree: pending.preparingWorktree,
        localDispatch: activeThread
          ? createLocalDispatchSnapshot(activeThread, {
              preparingWorktree: pending.preparingWorktree,
            })
          : pending.localDispatch,
        failureMessage: "Failed to retry send.",
        onNonTransportFailure: (message, failureRollback) => {
          removeOptimisticMessage(pending.optimisticMessageId);
          if (composerMatchesClearedState()) {
            restoreComposerRollback(failureRollback);
          } else {
            setComposerDraftInteractionMode(threadId, failureRollback.interactionMode);
            if (draftThread) {
              setDraftThreadContext(threadId, {
                interactionMode: failureRollback.interactionMode,
              });
            }
          }
          setThreadError(artifacts.command.threadId, message);
        },
      });
    } finally {
      sendInFlightRef.current = false;
    }
  }, [
    activeThread,
    clearPendingTurnDispatch,
    composerMatchesClearedState,
    dispatchPendingTurnStartCommand,
    draftThread,
    removeOptimisticMessage,
    restoreComposerRollback,
    setComposerDraftInteractionMode,
    setDraftThreadContext,
    setThreadError,
    threadId,
  ]);

  const onRestorePendingTurnDispatchDraft = useCallback(() => {
    const pending = pendingTurnDispatchRef.current;
    if (!pending) {
      return;
    }
    const artifacts = getPendingTurnDispatchArtifacts(pending.commandId);
    removeOptimisticMessage(pending.optimisticMessageId);
    clearPendingTurnDispatch({ commandId: pending.commandId });
    if (artifacts) {
      restoreComposerRollback(artifacts.rollback);
      setThreadError(artifacts.command.threadId, null);
      return;
    }
    setThreadError(threadId, null);
  }, [
    clearPendingTurnDispatch,
    removeOptimisticMessage,
    restoreComposerRollback,
    setThreadError,
    threadId,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread || isPendingTurnDispatchBlocked) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedModel = resolveAppModelSelection(
        provider,
        customModelsByProvider[provider],
        model,
      );
      setComposerDraftProvider(activeThread.id, provider);
      setComposerDraftModel(activeThread.id, resolvedModel);
      recordModelSelection(provider, resolvedModel, composerDraft.modelOptions);
      scheduleComposerFocus();
    },
    [
      activeThread,
      composerDraft.modelOptions,
      customModelsByProvider,
      isPendingTurnDispatchBlocked,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModel,
      setComposerDraftProvider,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (isPendingTurnDispatchBlocked) {
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      isPendingTurnDispatchBlocked,
      scheduleComposerFocus,
      setDraftThreadContext,
      threadId,
    ],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (isPendingTurnDispatchBlocked) {
        return;
      }
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `@${item.path} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const replacement = "/model ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = buildComposerSkillReplacement(item.name);
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      onProviderModelSelect(item.provider, item.model);
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
    },
    [
      applyPromptReplacement,
      handleInteractionModeChange,
      isPendingTurnDispatchBlocked,
      onProviderModelSelect,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      void onSend();
      return true;
    }
    return false;
  };
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = clearDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [navigate, threadId],
  );
  const handleFileNavigation = useCallback(
    (filePath: string, turnId?: TurnId): boolean => {
      if (!settings.openFileLinksInPanel) {
        return false;
      }

      const parsed = normalizeFilePathForDiffLookup(filePath, workspaceRoot);
      if (!parsed || !parsed.workspaceRelative) {
        return false;
      }

      if (
        shouldOpenFileInDiffPanel({
          parsedFilePath: parsed,
          turnId,
          diffFilePathsByTurnId,
        })
      ) {
        void navigate({
          to: "/$threadId",
          params: { threadId },
          search: (previous) => ({
            ...clearDiffSearchParams(previous),
            diff: "1",
            diffFilePath: parsed.path,
            ...(turnId ? { diffTurnId: turnId } : {}),
          }),
        });
        return true;
      }

      void queryClient.invalidateQueries({
        queryKey: providerQueryKeys.fileContent({
          cwd: workspaceRoot,
          relativePath: parsed.path,
        }),
      });
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => ({
          ...clearFileViewSearchParams(previous),
          fileViewPath: parsed.path,
          ...(parsed.line ? { fileLine: parsed.line } : {}),
          ...(parsed.column ? { fileColumn: parsed.column } : {}),
        }),
      });
      return true;
    },
    [
      diffFilePathsByTurnId,
      navigate,
      queryClient,
      settings.openFileLinksInPanel,
      threadId,
      workspaceRoot,
    ],
  );
  const onRevertUserMessage = (messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  };

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <FileNavigationProvider value={handleFileNavigation}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* Top bar */}
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
          )}
        >
          <ChatHeader
            activeThreadId={activeThread.id}
            activeThreadTitle={activeThread.title}
            estimatedContextTokens={activeThread.estimatedContextTokens}
            modelContextWindowTokens={activeThread.modelContextWindowTokens}
            model={activeThread.model}
            provider={activeThread.session?.provider ?? null}
            tokenUsageSource={activeThread.session?.tokenUsageSource}
            activeProjectName={activeProject?.name}
            workflowTitle={activeWorkflow?.workflow.title}
            onOpenWorkflow={
              activeWorkflow
                ? () => {
                    void navigate({
                      to:
                        activeWorkflow.type === "planning"
                          ? "/workflow/$workflowId"
                          : "/code-review/$workflowId",
                      params: { workflowId: activeWorkflow.workflow.id },
                    });
                  }
                : undefined
            }
            isGitRepo={isGitRepo}
            openInCwd={activeThread.worktreePath ?? activeProject?.cwd ?? null}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            terminalAvailable={activeProject != null}
            terminalOpen={terminalState.terminalOpen}
            terminalToggleShortcutLabel={terminalToggleShortcutLabel}
            diffToggleShortcutLabel={diffPanelShortcutLabel}
            gitCwd={gitCwd}
            diffOpen={diffOpen}
            onRunProjectScript={(script) => {
              void runProjectScript(script);
            }}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
            onToggleTerminal={toggleTerminalVisibility}
            onToggleDiff={onToggleDiff}
          />
        </header>

        {/* Error banner */}
        <ProviderHealthBanner
          status={isProviderStatusDismissed ? null : activeProviderStatus}
          onDismiss={() => {
            if (activeProviderStatusKey) {
              setDismissedProviderStatusKey(activeProviderStatusKey);
            }
          }}
        />
        {settings.showProviderRuntimeMetadata ? (
          <ProviderRuntimeInfoBanner
            provider={sessionProvider ?? selectedProviderByThreadId ?? null}
            entries={providerRuntimeInfoEntries}
          />
        ) : null}
        <PendingSendRecoveryBanner
          visible={pendingTurnDispatchAwaitingUserAction}
          onRetrySend={() => {
            void onRetryPendingTurnDispatch();
          }}
          onRestoreDraft={onRestorePendingTurnDispatchDraft}
        />
        <ThreadErrorBanner
          error={activeThread.error}
          onDismiss={() => setThreadError(activeThread.id, null)}
        />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {shouldRenderTimeline ? (
                <MessagesTimeline
                  key={activeThread.id}
                  threadId={activeThread.id}
                  hasMessages={timelineEntries.length > 0}
                  isWorking={isWorking}
                  activeTurnStartedAt={activeWorkStartedAt}
                  listRef={legendListRef}
                  onIsAtEndChange={onIsAtEndChange}
                  timelineEntries={timelineEntries}
                  completionDividerBeforeEntryId={completionDividerBeforeEntryId}
                  completionSummary={completionSummary}
                  turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                  turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
                  nowIso={nowIso}
                  expandedWorkGroups={expandedWorkGroups}
                  onToggleWorkGroup={onToggleWorkGroup}
                  onOpenTurnDiff={onOpenTurnDiff}
                  revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                  onRevertUserMessage={onRevertUserMessage}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImage}
                  markdownCwd={gitCwd ?? undefined}
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={workspaceRoot}
                  expandedCommandExecutions={expandedCommandExecutions}
                  onToggleCommandExecution={onToggleCommandExecution}
                  allDirectoriesExpanded={allDirectoriesExpanded}
                  onToggleAllDirectories={onToggleAllDirectories}
                  chatDiffContext={chatDiffContext}
                  listHeaderContent={
                    <>
                      {historyStatusContent}
                      {
                        // Tasks come only from the detail payload, so keep this
                        // gated on `detailsLoaded` even though the timeline can
                        // render from live events earlier.
                        activeThread.detailsLoaded && effectiveThreadTasks.length > 0 ? (
                          <div className="mx-auto mb-4 w-full max-w-3xl">
                            <ThreadTasksPanel
                              threadId={activeThread.id}
                              tasks={effectiveThreadTasks}
                              open={tasksPanelOpen}
                              summary={taskPanelSummary}
                              onToggle={() =>
                                setTasksPanelOpen((open) => {
                                  const nextOpen = !open;
                                  tasksPanelManuallyCollapsedRef.current = !nextOpen;
                                  return nextOpen;
                                })
                              }
                            />
                          </div>
                        ) : null
                      }
                    </>
                  }
                />
              ) : (
                <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-3 sm:px-5 sm:py-4">
                  <p className="px-1 text-xs text-muted-foreground">Loading thread details...</p>
                  <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-sm backdrop-blur-sm">
                    <div className="space-y-3">
                      <Skeleton className="h-4 w-28 rounded-full" />
                      <Skeleton className="h-3 w-full rounded-full" />
                      <Skeleton className="h-3 w-11/12 rounded-full" />
                      <Skeleton className="h-3 w-10/12 rounded-full" />
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-sm backdrop-blur-sm">
                    <div className="space-y-3">
                      <Skeleton className="h-4 w-36 rounded-full" />
                      <Skeleton className="h-3 w-full rounded-full" />
                      <Skeleton className="h-3 w-8/12 rounded-full" />
                    </div>
                  </div>
                </div>
              )}

              {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
              {showScrollToBottom && (
                <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                  <button
                    type="button"
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    {scrollToBottomShortcutLabel
                      ? `Scroll to bottom (${scrollToBottomShortcutLabel})`
                      : "Scroll to bottom"}
                  </button>
                </div>
              )}
            </div>

            {/* Input bar */}
            <div className={cn("px-3 pt-1.5 sm:px-5 sm:pt-2", isGitRepo ? "pb-1" : "pb-3 sm:pb-4")}>
              <form
                ref={composerFormRef}
                onSubmit={onSend}
                className="mx-auto w-full min-w-0 max-w-3xl"
                data-chat-composer-form="true"
              >
                <div
                  data-chat-composer-shell="true"
                  className={cn(
                    "group rounded-[20px] border bg-card transition-colors duration-200",
                    isDragOverComposer
                      ? "border-primary/70 bg-accent/30"
                      : interactionMode === "plan"
                        ? "border-warning/10 focus-within:border-warning/45"
                        : "border-border focus-within:border-ring/45",
                  )}
                  onDragEnter={onComposerDragEnter}
                  onDragOver={onComposerDragOver}
                  onDragLeave={onComposerDragLeave}
                  onDrop={onComposerDrop}
                >
                  {activePendingApproval ? (
                    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                      <ComposerPendingApprovalPanel
                        approval={activePendingApproval}
                        pendingCount={pendingApprovals.length}
                      />
                    </div>
                  ) : pendingUserInputs.length > 0 ? (
                    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                      <ComposerPendingUserInputPanel
                        pendingUserInputs={pendingUserInputs}
                        respondingRequestIds={respondingRequestIds}
                        answers={activePendingDraftAnswers}
                        questionIndex={activePendingQuestionIndex}
                        onSelectOption={onSelectActivePendingUserInputOption}
                        onToggleOption={onToggleActivePendingUserInputOption}
                        onAdvance={onAdvanceActivePendingUserInput}
                      />
                    </div>
                  ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                      <ComposerPlanFollowUpBanner
                        key={activeProposedPlan.id}
                        planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                      />
                    </div>
                  ) : null}

                  {/* Textarea area */}
                  <div
                    className={cn(
                      "relative px-3 pb-2 sm:px-4",
                      hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
                    )}
                  >
                    {composerMenuOpen && !isComposerApprovalState && (
                      <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                        <ComposerCommandMenu
                          items={composerMenuItems}
                          resolvedTheme={resolvedTheme}
                          isLoading={isComposerMenuLoading}
                          triggerKind={composerTriggerKind}
                          activeItemId={activeComposerMenuItem?.id ?? null}
                          onHighlightedItemChange={onComposerMenuItemHighlighted}
                          onSelect={onSelectComposerItem}
                        />
                      </div>
                    )}

                    {!isComposerApprovalState && pendingUserInputs.length === 0 && (
                      <>
                        {composerImages.length > 0 && (
                          <div className="mb-3 flex flex-wrap gap-2">
                            {composerImages.map((image) => (
                              <div
                                key={image.id}
                                className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                              >
                                {image.previewUrl ? (
                                  <button
                                    type="button"
                                    className="h-full w-full cursor-zoom-in"
                                    aria-label={`Preview ${image.name}`}
                                    onClick={() => {
                                      const preview = buildExpandedImagePreview(
                                        composerImages,
                                        image.id,
                                      );
                                      if (!preview) return;
                                      setExpandedImage(preview);
                                    }}
                                  >
                                    <img
                                      src={image.previewUrl}
                                      alt={image.name}
                                      className="h-full w-full object-cover"
                                    />
                                  </button>
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                                    {image.name}
                                  </div>
                                )}
                                {nonPersistedComposerImageIdSet.has(image.id) && (
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <span
                                          role="img"
                                          aria-label="Draft attachment may not persist"
                                          className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                        >
                                          <CircleAlertIcon className="size-3" />
                                        </span>
                                      }
                                    />
                                    <TooltipPopup
                                      side="top"
                                      className="max-w-64 whitespace-normal leading-tight"
                                    >
                                      Draft attachment could not be saved locally and may be lost on
                                      navigation.
                                    </TooltipPopup>
                                  </Tooltip>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                                  onClick={() => removeComposerImage(image.id)}
                                  aria-label={`Remove ${image.name}`}
                                  disabled={isPendingTurnDispatchBlocked}
                                >
                                  <XIcon />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                        {composerFilePaths.length > 0 && (
                          <div className="mb-3 flex flex-wrap gap-1.5">
                            {composerFilePaths.map((filePath) => {
                              const displayPath = relativePathForDisplay(
                                filePath,
                                activeThread?.worktreePath ?? activeProject?.cwd,
                              );
                              return (
                                <span
                                  key={filePath}
                                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-1 text-[12px] text-foreground"
                                  title={displayPath}
                                >
                                  <VscodeEntryIcon
                                    pathValue={filePath}
                                    kind="file"
                                    theme={resolvedTheme}
                                    className="size-3.5"
                                  />
                                  <span className="max-w-[200px] truncate">
                                    {basenameOfPath(displayPath)}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => removeComposerFilePath(filePath)}
                                    disabled={isPendingTurnDispatchBlocked}
                                    aria-label={`Remove ${displayPath}`}
                                  >
                                    <XIcon className="size-3" />
                                  </Button>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                    <ComposerPromptEditor
                      ref={composerEditorRef}
                      value={
                        isComposerApprovalState
                          ? ""
                          : activePendingProgress
                            ? activePendingProgress.customAnswer
                            : prompt
                      }
                      cursor={composerCursor}
                      terminalContexts={
                        !isComposerApprovalState && pendingUserInputs.length === 0
                          ? composerTerminalContexts
                          : []
                      }
                      onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                      onChange={onPromptChange}
                      onCommandKeyDown={onComposerCommandKey}
                      onPaste={onComposerPaste}
                      placeholder={
                        isComposerApprovalState
                          ? (activePendingApproval?.detail ??
                            "Resolve this approval request to continue")
                          : activePendingProgress
                            ? "Type your own answer, or leave this blank to use the selected option"
                            : showPlanFollowUpPrompt && activeProposedPlan
                              ? "Add feedback to refine the plan, or leave this blank to implement it"
                              : phase === "disconnected"
                                ? "Ask for follow-up changes or attach files"
                                : "Ask anything, @tag files/folders, or use / to show available commands"
                      }
                      disabled={
                        isConnecting || isComposerApprovalState || isPendingTurnDispatchBlocked
                      }
                    />
                  </div>

                  {/* Bottom toolbar */}
                  {activePendingApproval ? (
                    <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                      <ComposerPendingApprovalActions
                        requestId={activePendingApproval.requestId}
                        isResponding={respondingRequestIds.includes(
                          activePendingApproval.requestId,
                        )}
                        onRespondToApproval={onRespondToApproval}
                      />
                    </div>
                  ) : (
                    <div
                      data-chat-composer-footer="true"
                      className={cn(
                        "flex items-center justify-between px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                        isComposerFooterCompact
                          ? "gap-1.5"
                          : "flex-wrap gap-2 sm:flex-nowrap sm:gap-0",
                      )}
                    >
                      <div
                        className={cn(
                          "flex min-w-0 flex-1 items-center",
                          isComposerFooterCompact
                            ? "-m-1 gap-1 overflow-hidden p-1"
                            : "-m-1 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                        )}
                      >
                        {/* Provider/model picker */}
                        <ProviderModelPicker
                          compact={isComposerFooterCompact}
                          provider={selectedProvider}
                          model={selectedModelForPickerWithCustomFallback}
                          lockedProvider={lockedProvider}
                          modelOptionsByProvider={modelOptionsByProvider}
                          ultrathinkActive={isClaudeUltrathink}
                          disabled={isPendingTurnDispatchBlocked}
                          onProviderModelChange={onProviderModelSelect}
                        />

                        {isComposerFooterCompact ? (
                          <CompactComposerControlsMenu
                            activePlan={Boolean(
                              activePlan || activeProposedPlan || planSidebarOpen,
                            )}
                            canCompactConversation={canCompactConversation}
                            compactConversationDisabled={isWorking || hasPendingTurnDispatch}
                            disabled={isPendingTurnDispatchBlocked}
                            interactionMode={interactionMode}
                            planSidebarOpen={planSidebarOpen}
                            runtimeMode={runtimeMode}
                            traitsMenuContent={
                              selectedProvider === "codex" ? (
                                <CodexTraitsMenuContent threadId={threadId} />
                              ) : selectedProvider === "claudeAgent" &&
                                supportsClaudeTraitsControls(selectedModel) ? (
                                <ClaudeTraitsMenuContent
                                  threadId={threadId}
                                  model={selectedModel}
                                  onPromptChange={setPromptFromTraits}
                                />
                              ) : null
                            }
                            onCompactConversation={onCompactConversation}
                            onToggleInteractionMode={toggleInteractionMode}
                            onTogglePlanSidebar={togglePlanSidebar}
                            onToggleRuntimeMode={toggleRuntimeMode}
                          />
                        ) : (
                          <>
                            {selectedProvider === "codex" ? (
                              <>
                                <Separator
                                  orientation="vertical"
                                  className="mx-0.5 hidden h-4 sm:block"
                                />
                                <CodexTraitsPicker threadId={threadId} />
                              </>
                            ) : selectedProvider === "claudeAgent" &&
                              supportsClaudeTraitsControls(selectedModel) ? (
                              <>
                                <Separator
                                  orientation="vertical"
                                  className="mx-0.5 hidden h-4 sm:block"
                                />
                                <ClaudeTraitsPicker
                                  threadId={threadId}
                                  model={selectedModel}
                                  onPromptChange={setPromptFromTraits}
                                />
                              </>
                            ) : null}

                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />

                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                              size="sm"
                              type="button"
                              onClick={toggleInteractionMode}
                              disabled={isPendingTurnDispatchBlocked}
                              title={
                                interactionMode === "plan"
                                  ? "Plan mode — click to return to normal chat mode"
                                  : "Default mode — click to enter plan mode"
                              }
                            >
                              {interactionMode === "plan" ? <NotebookPenIcon /> : <BotIcon />}
                              <span className="sr-only sm:not-sr-only">
                                {interactionMode === "plan" ? "Plan" : "Agent"}
                              </span>
                            </Button>

                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />

                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                              size="sm"
                              type="button"
                              onClick={() =>
                                void handleRuntimeModeChange(
                                  runtimeMode === "full-access"
                                    ? "approval-required"
                                    : "full-access",
                                )
                              }
                              disabled={isPendingTurnDispatchBlocked}
                              title={
                                runtimeMode === "full-access"
                                  ? "Full access — click to require approvals"
                                  : "Approval required — click for full access"
                              }
                            >
                              {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                              <span className="sr-only sm:not-sr-only">
                                {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                              </span>
                            </Button>

                            {activePlan || activeProposedPlan || planSidebarOpen ? (
                              <>
                                <Separator
                                  orientation="vertical"
                                  className="mx-0.5 hidden h-4 sm:block"
                                />
                                <Button
                                  variant="ghost"
                                  className={cn(
                                    "shrink-0 whitespace-nowrap px-2 sm:px-3",
                                    planSidebarOpen
                                      ? "text-blue-400 hover:text-blue-300"
                                      : "text-muted-foreground/70 hover:text-foreground/80",
                                  )}
                                  size="sm"
                                  type="button"
                                  onClick={togglePlanSidebar}
                                  disabled={isPendingTurnDispatchBlocked}
                                  title={
                                    planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"
                                  }
                                >
                                  <ListTodoIcon />
                                  <span className="sr-only sm:not-sr-only">Plan</span>
                                </Button>
                              </>
                            ) : null}
                          </>
                        )}
                      </div>

                      {/* Right side: send / stop button */}
                      <div
                        data-chat-composer-actions="right"
                        className="flex shrink-0 items-center gap-2"
                      >
                        {isPreparingWorktree ? (
                          <span className="text-muted-foreground/70 text-xs">
                            Preparing worktree...
                          </span>
                        ) : null}
                        {activePendingProgress ? (
                          <div className="flex items-center gap-2">
                            {activePendingProgress.questionIndex > 0 ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-full"
                                onClick={onPreviousActivePendingUserInputQuestion}
                                disabled={activePendingIsResponding}
                              >
                                Previous
                              </Button>
                            ) : null}
                            <Button
                              type="submit"
                              size="sm"
                              className="rounded-full px-4"
                              disabled={
                                activePendingIsResponding ||
                                (activePendingProgress.isLastQuestion
                                  ? !activePendingResolvedAnswers
                                  : !activePendingProgress.canAdvance)
                              }
                            >
                              {activePendingIsResponding
                                ? "Submitting..."
                                : activePendingProgress.isLastQuestion
                                  ? "Submit answers"
                                  : "Next question"}
                            </Button>
                          </div>
                        ) : phase === "running" ? (
                          <button
                            type="button"
                            className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
                            onClick={() => void onInterrupt()}
                            aria-label="Stop generation"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <rect x="2" y="2" width="8" height="8" rx="1.5" />
                            </svg>
                          </button>
                        ) : pendingUserInputs.length === 0 ? (
                          showPlanFollowUpPrompt ? (
                            prompt.trim().length > 0 ? (
                              <Button
                                type="submit"
                                size="sm"
                                className="h-9 rounded-full px-4 sm:h-8"
                                disabled={isPendingTurnDispatchBlocked || isConnecting}
                              >
                                {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                              </Button>
                            ) : (
                              <div className="flex items-center">
                                <Button
                                  type="submit"
                                  size="sm"
                                  className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                                  disabled={isPendingTurnDispatchBlocked || isConnecting}
                                >
                                  {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                                </Button>
                                <Menu>
                                  <MenuTrigger
                                    render={
                                      <Button
                                        size="sm"
                                        variant="default"
                                        className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                        aria-label="Implementation actions"
                                        disabled={isPendingTurnDispatchBlocked || isConnecting}
                                      />
                                    }
                                  >
                                    <ChevronDownIcon className="size-3.5" />
                                  </MenuTrigger>
                                  <MenuPopup align="end" side="top">
                                    <MenuItem
                                      disabled={isPendingTurnDispatchBlocked || isConnecting}
                                      onClick={() => void onImplementPlanInNewThread()}
                                    >
                                      Implement in a new thread
                                    </MenuItem>
                                  </MenuPopup>
                                </Menu>
                              </div>
                            )
                          ) : (
                            <button
                              type="submit"
                              className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
                              disabled={
                                isPendingTurnDispatchBlocked ||
                                isConnecting ||
                                !composerSendState.hasSendableContent
                              }
                              aria-label={
                                isConnecting
                                  ? "Connecting"
                                  : isPreparingWorktree
                                    ? "Preparing worktree"
                                    : isSendBusy
                                      ? "Sending"
                                      : "Send message"
                              }
                            >
                              {isConnecting || isSendBusy ? (
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 14 14"
                                  fill="none"
                                  className="animate-spin"
                                  aria-hidden="true"
                                >
                                  <circle
                                    cx="7"
                                    cy="7"
                                    r="5.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeDasharray="20 12"
                                  />
                                </svg>
                              ) : (
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 14 14"
                                  fill="none"
                                  aria-hidden="true"
                                >
                                  <path
                                    d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </form>
            </div>

            {isGitRepo && (
              <BranchToolbar
                threadId={activeThread.id}
                onEnvModeChange={onEnvModeChange}
                envLocked={envLocked}
                onComposerFocusRequest={scheduleComposerFocus}
                {...(canCheckoutPullRequestIntoThread
                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                  : {})}
              />
            )}
            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                cwd={activeProject?.cwd ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}

          {/* Plan sidebar */}
          {planSidebarOpen && !shouldUsePlanSidebarSheet ? (
            <PlanSidebar
              activePlan={activePlan}
              activeProposedPlan={activeProposedPlan}
              markdownCwd={gitCwd ?? undefined}
              workspaceRoot={activeProject?.cwd ?? undefined}
              timestampFormat={timestampFormat}
              mode="sidebar"
              onClose={closePlanSidebar}
            />
          ) : null}
        </div>
        {/* end horizontal flex container */}

        {(() => {
          if (!terminalState.terminalOpen || !activeProject) {
            return null;
          }
          return (
            <ThreadTerminalDrawer
              key={activeThread.id}
              threadId={activeThread.id}
              cwd={gitCwd ?? activeProject.cwd}
              runtimeEnv={threadTerminalRuntimeEnv}
              height={terminalState.terminalHeight}
              terminalIds={terminalState.terminalIds}
              activeTerminalId={terminalState.activeTerminalId}
              terminalGroups={terminalState.terminalGroups}
              activeTerminalGroupId={terminalState.activeTerminalGroupId}
              focusRequestId={terminalFocusRequestId}
              onSplitTerminal={splitTerminal}
              onNewTerminal={createNewTerminal}
              splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
              newShortcutLabel={newTerminalShortcutLabel ?? undefined}
              closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
              onActiveTerminalChange={activateTerminal}
              onCloseTerminal={closeTerminal}
              onHeightChange={setTerminalHeight}
              onAddTerminalContext={addTerminalContextToDraft}
            />
          );
        })()}

        {shouldUsePlanSidebarSheet ? (
          <RightPanelSheet open={planSidebarOpen} onClose={closePlanSidebar}>
            <PlanSidebar
              activePlan={activePlan}
              activeProposedPlan={activeProposedPlan}
              markdownCwd={gitCwd ?? undefined}
              workspaceRoot={activeProject?.cwd ?? undefined}
              timestampFormat={timestampFormat}
              mode="sheet"
              onClose={closePlanSidebar}
            />
          </RightPanelSheet>
        ) : null}

        {expandedImage && expandedImageItem && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded image preview"
          >
            <button
              type="button"
              className="absolute inset-0 z-0 cursor-zoom-out"
              aria-label="Close image preview"
              onClick={closeExpandedImage}
            />
            {expandedImage.images.length > 1 && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
                aria-label="Previous image"
                onClick={() => {
                  navigateExpandedImage(-1);
                }}
              >
                <ChevronLeftIcon className="size-5" />
              </Button>
            )}
            <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="absolute right-2 top-2"
                onClick={closeExpandedImage}
                aria-label="Close image preview"
              >
                <XIcon />
              </Button>
              <img
                src={expandedImageItem.src}
                alt={expandedImageItem.name}
                className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
                draggable={false}
              />
              <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
                {expandedImageItem.name}
                {expandedImage.images.length > 1
                  ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                  : ""}
              </p>
            </div>
            {expandedImage.images.length > 1 && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
                aria-label="Next image"
                onClick={() => {
                  navigateExpandedImage(1);
                }}
              >
                <ChevronRightIcon className="size-5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </FileNavigationProvider>
  );
}
