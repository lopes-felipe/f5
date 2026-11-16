import { McpAppFrame } from "./McpAppFrame";
import { settleListScroll } from "./settleListScroll";
import { AttachmentImage } from "../AttachmentImage";
import { ThreadFindContext } from "./threadFindContext";
import { highlightThreadFind } from "./threadFindHighlights";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { recordTimelineRowRender } from "../../lib/performanceCounters";
import { messageTextRevision, messageReasoningContent } from "../../lib/streamingTextRevision";
import { computerToolHeading, previewToolHeading } from "@t3tools/shared/computerAction";
import {
  automationRunEnd,
  classifyAutomationEntry,
  isAutomationEntryFailed,
  summarizeAutomationRun,
  type AutomationSurface,
} from "./AutomationSessionCard.logic";
import { AutomationSessionCard } from "./AutomationSessionCard";
import { McpToolCallDetails } from "./McpToolCallDetails";
import type { PromptLinkRepository } from "@t3tools/shared/promptLinks";
import { NativeFilePreview } from "./NativeFilePreview";
import { AttachmentFileChip } from "./AttachmentFileChip";
import { ChatAssetImage } from "../ChatAssetImage";
import { readTimelineScrollAnchor, timelineScrollAnchors } from "./timelineScrollAnchors";
import {
  type MessageId,
  type OrchestrationFileChangeId,
  type OrchestrationFileChangeSummary,
  type ProviderSessionCapabilities,
  type ThreadId,
  type TurnId,
  type UserMessageSkillCall,
} from "@t3tools/contracts";
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { InlineExactFileChangeDiffProps } from "./InlineExactFileChangeDiff";
import type { InlineFileChangeDiffProps } from "./InlineFileChangeDiff";
import { LegendList, type LegendListRef, type OnViewableItemsChanged } from "@legendapp/list/react";
import {
  deriveTimelineEntries,
  timelineEntriesStructure,
  formatDuration,
  formatElapsed,
  type LiveWorkActivity,
} from "../../session-logic";
import { attachmentPreviewUrlForId } from "../../orchestrationState";
import { type TurnDiffSummary } from "../../types";
import { changedLineCount, summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BanIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  ClockIcon,
  EyeIcon,
  FigmaIcon,
  GlobeIcon,
  HammerIcon,
  ImageIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MessageSquarePlusIcon,
  SearchIcon,
  SlackIcon,
  SquarePenIcon,
  TerminalIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { ClaudeAI, GitHubIcon, LinearIcon, McpIcon, NotionIcon, type Icon } from "../Icons";
import {
  mcpAggregateStatus,
  mcpServerIconKind,
  mcpServerTint,
  summarizeMcpResult,
  type McpCallDisplayStatus,
} from "../../lib/mcpServerDisplay";
import { SectionLabel } from "../ui/section-label";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { FileChip } from "./FileChip";
import { ComposerDockSpacer } from "./composer/ComposerDock";
import { openFileInEditor } from "../../lib/openFileInEditor";
import { useFileNavigation } from "../../fileNavigationContext";
import { Button } from "../ui/button";
import { TooltipScrollDismissArea } from "../ui/tooltip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import type { ImageAttachmentActionItem } from "./imageAttachmentActions";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { CommandTranscriptCard } from "./CommandTranscriptCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { PromptLinkCopyButton } from "../promptLinks/PromptLinkCopyButton";
import { UserMessageRevertPopover } from "./UserMessageRevertPopover";
import { computeRevertImpact } from "./revertImpact";
import { AssistantMessageActions } from "./AssistantMessageActions";
import { PromptCacheMissPill } from "./PromptCacheMissPill";
import type { TurnCacheSummary } from "./cacheIndicator.logic";
import {
  buildTimelineEntryRowIndexMap,
  computeMessageDurationStart,
  deriveCodexCollaborationResponseRows,
  deriveTimelineTurnRailItems,
  deriveTimelineAssistantRailItems,
  describeDynamicToolEntry,
  type DynamicToolIconKind,
  findNearestMinimapMarkerIndex,
  formatWorkingLabel,
  isFileChangeWorkEntry,
  isFileReadWorkEntry,
  isSearchWorkEntry,
  mcpServerMonogram,
  normalizeCompactToolLabel,
  parseJsonObject,
  summarizeToolInputPairs,
  normalizedSearchSummary,
  normalizedWorkEntryHeading,
  resolveActiveTurnRailIndex,
  resolveCodexCollaborationHeading,
  resolveCodexCollaborationStatusLabel,
  resolveTimelineTurnRailHasPersistentGutter,
  resolveTimelineTurnRailHitStripWidth,
  sampleTimelineMinimapRowIndices,
  summarizeWorkGroup,
  TIMELINE_TURN_RAIL_MIN_ITEMS,
  advanceRowArrivals,
  type RowArrivalState,
  type TimelineTurnRailItem,
  timelineIsAtEnd,
  TIMELINE_AT_END_PX,
} from "./MessagesTimeline.logic";
import { TimelineTurnRail } from "./TimelineTurnRail";
import { createPortal } from "react-dom";
import {
  ConversationNavigation,
  createConversationNavigationStore,
} from "./ConversationNavigation";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import { WorkingRibbon, type WorkingRibbonReleaseReason } from "./WorkingRibbon";
import { useNowIso } from "../../lib/nowTicker";
import type { RibbonPoint } from "./WorkingRibbon.logic";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { SkillInlineChip } from "./SkillInlineChip";
import { UserInputCard } from "./UserInputCard";
import { ThreadReferenceChip } from "./ThreadReferenceChip";
import { threadReferenceMatches } from "@t3tools/shared/threadReferences";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { answerDeliveryDisplayText } from "~/lib/answerDelivery";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { cn } from "~/lib/utils";
import { type AppSettings, type TimestampFormat, useAppSettingsSelector } from "../../appSettings";
import {
  extractTerminalLinks,
  resolvePathLinkTarget,
  splitPathAndPosition,
} from "../../terminal-links";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { CollapsibleUserMessageBody } from "./CollapsibleUserMessageBody";
import { iconForItemType } from "./workEntryIcons";
import {
  clipUserMessageSegments,
  hasUserMessageMarkup,
  parseUserMessageMarkup,
} from "../../lib/userMessageMarkup";
import { ReasoningSection } from "./ReasoningSection";
import { MessageTokenUsage } from "./MessageTokenUsage";
import { COMPOSER_INLINE_CHIP_CLASS_NAME } from "../composerInlineChip";
import { DiffSurfaceBoundary } from "../DiffSurfaceBoundary";
import { SurfaceErrorBoundary, type SurfaceErrorFallbackProps } from "../ui/SurfaceErrorBoundary";
import { copyErrorReport } from "../../lib/errorReport";
import { useTestRenderCountProps } from "../../lib/testRenderCount";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import {
  classifyCompactCommand,
  isGenericCommandTitle,
  resolveCommandExecutionSummaryText,
} from "@t3tools/shared/commandSummary";
import { WORK_LOG_PAGE_SIZE } from "./workLogConstants";
import {
  CHANGED_FILES_COMPACT_PREVIEW_COUNT,
  resolveChangedFilesPresentation,
  type ChangedFilesPresentation,
} from "./changedFilesPresentation";

export interface MessagesTimelineEmptyState {
  projectName: string | null;
  envMode: "local" | "worktree";
  branch: string | null;
}

function MessagesTimelineEmpty(props: { emptyState: MessagesTimelineEmptyState | undefined }) {
  const { emptyState } = props;
  const envLabel = emptyState
    ? [emptyState.envMode === "worktree" ? "Worktree" : "Local", emptyState.branch]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <Empty className="flex-1 gap-3" data-testid="messages-timeline-empty">
      {emptyState ? (
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquarePlusIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">
            {emptyState.projectName ? `New thread in ${emptyState.projectName}` : "New thread"}
          </EmptyTitle>
          {envLabel ? (
            <EmptyDescription className="text-ui tabular-nums">{envLabel}</EmptyDescription>
          ) : null}
        </EmptyHeader>
      ) : null}
      <p className="text-ui text-muted-foreground">Send a message to start the conversation.</p>
    </Empty>
  );
}

// Drawn inside the media so dark screenshots keep an edge on the dark background.
const USER_MEDIA_EDGE_CLASS_NAME =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12";

const WORK_META_CHIP_CLASS_NAME =
  "inline-flex h-5 items-center rounded-md border border-border bg-muted/50 px-1.5 text-2xs text-muted-foreground";

type InlineExactFileChangeDiffComponent =
  (typeof import("./InlineExactFileChangeDiff"))["InlineExactFileChangeDiff"];
type InlineFileChangeDiffComponent =
  (typeof import("./InlineFileChangeDiff"))["InlineFileChangeDiff"];

let loadedInlineExactFileChangeDiff: InlineExactFileChangeDiffComponent | null = null;
let loadedInlineFileChangeDiff: InlineFileChangeDiffComponent | null = null;
let inlineExactFileChangeDiffPromise: Promise<void> | null = null;
let inlineFileChangeDiffPromise: Promise<void> | null = null;

function loadInlineExactFileChangeDiff(): Promise<void> {
  inlineExactFileChangeDiffPromise ??= import("./InlineExactFileChangeDiff").then((module) => {
    loadedInlineExactFileChangeDiff = module.InlineExactFileChangeDiff;
  });
  return inlineExactFileChangeDiffPromise;
}

function loadInlineFileChangeDiff(): Promise<void> {
  inlineFileChangeDiffPromise ??= import("./InlineFileChangeDiff").then((module) => {
    loadedInlineFileChangeDiff = module.InlineFileChangeDiff;
  });
  return inlineFileChangeDiffPromise;
}

export async function preloadInlineDiffComponents(): Promise<void> {
  await Promise.all([loadInlineExactFileChangeDiff(), loadInlineFileChangeDiff()]);
}

function InlineExactFileChangeDiff(props: InlineExactFileChangeDiffProps) {
  const Component = loadedInlineExactFileChangeDiff;
  if (!Component) throw loadInlineExactFileChangeDiff();
  return <Component {...props} />;
}

function InlineFileChangeDiff(props: InlineFileChangeDiffProps) {
  const Component = loadedInlineFileChangeDiff;
  if (!Component) throw loadInlineFileChangeDiff();
  return <Component {...props} />;
}

/**
 * Rows playing their entrance animation. A context rather than a row-externals
 * input: an arrival (and its expiry) re-renders only the mounted row wrappers,
 * instead of re-describing every row of a long thread.
 */
const RowEnteringContext = createContext<ReadonlyMap<string, number>>(new Map());

const EMPTY_WORK_GROUP_COLLAPSE_OVERRIDES: Readonly<Record<string, boolean>> = {};
const EMPTY_CACHE_MISSES: ReadonlyMap<MessageId, TurnCacheSummary> = new Map();

interface MessagesTimelineProps {
  nativeSessionCapabilities?:
    | import("@t3tools/contracts").ProviderSessionCapabilities
    | null
    | undefined;
  threadId?: ThreadId | null;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  /** What the running turn is doing now; null shows a plain "Working". */
  liveActivity?: LiveWorkActivity | undefined;
  listRef: React.RefObject<LegendListRef | null>;
  entryRowIndexMapRef?: MutableRefObject<ReadonlyMap<string, number> | null>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /**
   * Bumped when a send starts a new turn: the next tail advance is followed
   * even if the user had scrolled up. Steers, queued and rejected sends never
   * bump it.
   */
  followNextTailNonce?: number;
  autoFollow?: boolean;
  onAutoFollowChange?: ((enabled: boolean) => void) | undefined;
  hasOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  hasHistoryLoadError?: boolean;
  onLoadOlderHistory?: ((signal: AbortSignal) => Promise<void>) | undefined;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  /** Turns that missed the prompt cache, keyed by the reply whose footer flags it. */
  cacheMissByAssistantMessageId?: ReadonlyMap<MessageId, TurnCacheSummary>;
  expandedWorkGroups: Record<string, number>;
  onToggleWorkGroup: (groupId: string, paginatedEntryCount: number) => void;
  /**
   * Per-group overrides of the "collapse finished work logs" setting:
   * `true` keeps a prior turn's group open, `false` collapses it.
   */
  workGroupCollapseOverrides?: Readonly<Record<string, boolean>>;
  onSetWorkGroupExpanded?: ((groupId: string, expanded: boolean) => void) | undefined;
  /** Context for the empty-thread state; omitted renders the plain hint. */
  emptyState?: MessagesTimelineEmptyState | undefined;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  onRevertUserMessage: (
    messageId: MessageId,
    restoreFiles?: boolean,
    /** The newest message when the user opened the confirmation. */
    expectedLatestMessageId?: MessageId | null,
  ) => void;
  /** The thread's newest message, captured when the revert popover opens. */
  latestMessageId?: MessageId | null | undefined;
  /** Called once a reopen request has been seen, so it is never replayed. */
  onRevertReopenHandled?: ((nonce: number) => void) | undefined;
  canRestoreFiles?: boolean | undefined;
  /** True while a revert of this thread is being dispatched or is still running. */
  isRevertingCheckpoint: boolean;
  /** Why revert is unavailable (agent running, pending send, unsupported provider). */
  revertDisabledReason?: string | null | undefined;
  /** Scope for remembering the revert popover's files choice. */
  revertPreferenceKey?: string | undefined;
  /**
   * The revert that is currently running. Rows from its target onward stay
   * dimmed and a status pill marks where the conversation will end.
   */
  pendingRevert?: PendingRevertDisplay | null | undefined;
  /** Opens the revert popover for a message, e.g. from a failure toast. */
  revertReopenRequest?: RevertReopenRequest | null | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onImageActionMenu?:
    | ((item: ImageAttachmentActionItem, position: { x: number; y: number }) => void)
    | undefined;
  usesCustomImageContextMenu?: boolean | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  expandedCommandExecutions: Record<string, boolean>;
  onToggleCommandExecution: (commandExecutionId: string) => void;
  /**
   * Whether the "Changed files" directory tree is expanded for the active
   * thread. Owned and persisted by the parent, so navigating away and back
   * (or restarting the app) preserves the user's choice.
   */
  allDirectoriesExpanded: boolean;
  onToggleAllDirectories: () => void;
  /**
   * Optional content rendered inside the virtualized list above the first row
   * (but after the top spacer). Used by ChatView to keep the f3-code-specific
   * thread tasks panel scrolling with messages once the scroll container moved
   * from ChatView into the LegendList itself.
   */
  listHeaderContent?: ReactNode;
  chatDiffContext?: ChatDiffContext;
  /**
   * The steerable working ribbon went away while it had focus and the
   * working label it would return focus to is gone too (the turn ended).
   */
  onWorkingRibbonFocusLost?: (() => void) | undefined;
  /** Quotes a settled assistant message into the composer; omitted hides "Quote in reply". */
  onQuoteAssistantMessage?: ((messageId: MessageId, text: string) => void) | undefined;
  /**
   * Routes rail, minimap, popover and revert jumps through the navigation
   * owner. Omitted scrolls to the row directly.
   */
  onNavigateToEntry?: ((entryId: string, position: number) => void) | undefined;
  /**
   * Filled with the timeline's own "the reader left the end" step, so a jump
   * owned elsewhere stops tail-following in the same frame it scrolls.
   */
  leaveEndRef?: MutableRefObject<(() => void) | null> | undefined;
  onLeaveEnd?: (() => void) | undefined;
  /** Runs after each committed change of the entry-to-row map. */
  onEntryRowIndexMapCommit?: (() => void) | undefined;
  /** Header element the "Conversation navigation" control portals into. */
  navigationHost?: HTMLElement | null | undefined;
  /** Opens thread find; omitted hides the popover's "Find in thread". */
  onOpenThreadFind?: (() => void) | undefined;
  /** Retries a failed older-history load from the navigation popover. */
  onRetryOlderHistory?: (() => void) | undefined;
}

export interface PendingRevertDisplay {
  targetMessageId: MessageId;
  label: string;
}

export interface RevertReopenRequest {
  messageId: MessageId;
  restoreFiles: boolean;
  /** Changes on every request so asking twice for the same message reopens it. */
  nonce: number;
}

export interface ChatDiffContext {
  threadId: ThreadId | null;
  isGitRepo: boolean;
  /** The GitHub repository a copied prompt link names, when the thread's remote has one. */
  promptLinkRepository?: PromptLinkRepository | null;
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
  expandedFileChangeDiffs: Record<string, boolean>;
  fileChangeSummariesById: Record<string, OrchestrationFileChangeSummary>;
  onToggleFileChangeDiff: (workEntryId: string) => void;
  onOpenFileChangeDiff: (fileChangeId: OrchestrationFileChangeId, filePath?: string) => void;
}

function isInlineFileChangeDiffExpanded(
  workEntryId: string,
  expandedFileChangeDiffs: Record<string, boolean>,
): boolean {
  return expandedFileChangeDiffs[workEntryId] ?? true;
}

function formatInlineDiffFileCountLabel(fileCount: number): string {
  return fileCount === 1 ? "1 file" : `${fileCount} files`;
}

const EMPTY_CHAT_DIFF_CONTEXT: ChatDiffContext = {
  threadId: null,
  isGitRepo: false,
  promptLinkRepository: null,
  inferredCheckpointTurnCountByTurnId: {},
  expandedFileChangeDiffs: {},
  fileChangeSummariesById: {},
  onToggleFileChangeDiff: () => {},
  onOpenFileChangeDiff: () => {},
};

// Only these settings re-render the timeline; other setting writes keep the selection.
function selectTimelineSettings(settings: AppSettings) {
  return {
    collapseCompletedWorkLogs: settings.collapseCompletedWorkLogs,
    expandMcpToolCallCardsByDefault: settings.expandMcpToolCallCardsByDefault,
    expandMcpToolCalls: settings.expandMcpToolCalls,
    showFileChangeDiffsInline: settings.showFileChangeDiffsInline,
    showReasoningExpanded: settings.showReasoningExpanded,
    composerRichTextEnabled: settings.composerRichTextEnabled,
  };
}

export const MessagesTimeline = memo(function MessagesTimeline({
  nativeSessionCapabilities,
  threadId = null,
  hasMessages,
  isWorking,
  activeTurnStartedAt,
  liveActivity = null,
  listRef,
  entryRowIndexMapRef,
  onIsAtEndChange,
  followNextTailNonce = 0,
  autoFollow = false,
  onAutoFollowChange,
  hasOlderHistory = false,
  isLoadingOlderHistory = false,
  hasHistoryLoadError = false,
  onLoadOlderHistory,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  turnDiffSummaryByTurnId,
  cacheMissByAssistantMessageId = EMPTY_CACHE_MISSES,
  expandedWorkGroups,
  onToggleWorkGroup,
  workGroupCollapseOverrides = EMPTY_WORK_GROUP_COLLAPSE_OVERRIDES,
  onSetWorkGroupExpanded,
  emptyState,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  canRestoreFiles,
  isRevertingCheckpoint,
  revertDisabledReason = null,
  revertPreferenceKey,
  pendingRevert = null,
  revertReopenRequest = null,
  latestMessageId = null,
  onRevertReopenHandled,
  onImageExpand,
  onImageActionMenu,
  usesCustomImageContextMenu = false,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  expandedCommandExecutions,
  onToggleCommandExecution,
  allDirectoriesExpanded,
  onToggleAllDirectories,
  listHeaderContent,
  chatDiffContext = EMPTY_CHAT_DIFF_CONTEXT,
  onWorkingRibbonFocusLost,
  onQuoteAssistantMessage,
  onNavigateToEntry,
  leaveEndRef,
  onLeaveEnd,
  onEntryRowIndexMapCommit,
  navigationHost = null,
  onOpenThreadFind,
  onRetryOlderHistory,
}: MessagesTimelineProps) {
  const settings = useAppSettingsSelector(selectTimelineSettings);
  // The working label can be picked up and steered (see WorkingRibbon).
  const reducedMotion = useReducedMotion();
  const [ribbonOrigin, setRibbonOrigin] = useState<RibbonPoint | null>(null);
  const grabButtonRef = useRef<HTMLButtonElement | null>(null);
  if (ribbonOrigin && (!isWorking || reducedMotion)) setRibbonOrigin(null);
  const restoreRibbonFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      // Focus that already moved on (a control the user picked, or a ribbon
      // remounted by Strict Mode) is left alone.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) return;
      const button = grabButtonRef.current;
      if (button?.isConnected) button.focus({ preventScroll: true });
      else onWorkingRibbonFocusLost?.();
    });
  }, [onWorkingRibbonFocusLost]);
  const handleRibbonRelease = useCallback(
    (reason: WorkingRibbonReleaseReason) => {
      setRibbonOrigin(null);
      // On blur focus has already gone somewhere the user chose.
      if (reason !== "blur") restoreRibbonFocus();
    },
    [restoreRibbonFocus],
  );
  const ownedEntryRowIndexMapRef = useRef<ReadonlyMap<string, number> | null>(null);
  const resolvedEntryRowIndexMapRef = entryRowIndexMapRef ?? ownedEntryRowIndexMapRef;
  const [restoredAnchor] = useState(() =>
    threadId ? timelineScrollAnchors.get(threadId) : undefined,
  );
  const [initialScrollAtEndEnabled, setInitialScrollAtEndEnabled] = useState(
    restoredAnchor?.atEnd ?? true,
  );
  const [changedFilesPresentationOverrides, setChangedFilesPresentationOverrides] = useState<
    Readonly<Record<string, ChangedFilesPresentation>>
  >({});
  const isAtEndRef = useRef(restoredAnchor?.atEnd ?? true);
  // Physical position drives the rail; following intent can stay enabled during layout changes.
  const [railIsAtEnd, setRailIsAtEnd] = useState(false);
  const liveFollowEnabled = autoFollow;
  const liveFollowEnabledRef = useRef(autoFollow);
  useLayoutEffect(() => {
    liveFollowEnabledRef.current = autoFollow;
  }, [autoFollow]);
  const [atEndThreshold, setAtEndThreshold] = useState(0);
  const manualScrollGenerationRef = useRef(0);
  const newestTurnDiffId = useMemo(
    () =>
      [...turnDiffSummaryByAssistantMessageId.values()].toSorted((left, right) =>
        right.completedAt.localeCompare(left.completedAt),
      )[0]?.turnId ?? null,
    [turnDiffSummaryByAssistantMessageId],
  );

  const rowCacheRef = useRef<TimelineRowCache | null>(null);
  rowCacheRef.current ??= createTimelineRowCache();
  const rowCache = rowCacheRef.current;
  const rows = useMemo(
    () =>
      buildTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        completionSummary,
        turnDiffSummaryByTurnId,
        isWorking,
        activeTurnStartedAt,
        liveActivity,
        expandMcpToolCalls: settings.expandMcpToolCalls,
        cache: rowCache,
      }),
    [
      activeTurnStartedAt,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
      liveActivity,
      rowCache,
      settings.expandMcpToolCalls,
      timelineEntries,
      turnDiffSummaryByTurnId,
    ],
  );

  // Messages appended by a live turn (or right after a send) rise into place.
  // Work-log and working-indicator rows churn throughout a turn and stay still.
  // Kept identical while the ids are, so streaming deltas take the cheap path.
  const messageRowIdsRef = useRef<readonly string[]>([]);
  const messageRowIds = useMemo(() => {
    const next = rows.flatMap((row) => (row.kind === "message" ? [row.id] : []));
    const current = messageRowIdsRef.current;
    return next.length === current.length && next.every((id, index) => id === current[index])
      ? current
      : next;
  }, [rows]);
  useLayoutEffect(() => {
    messageRowIdsRef.current = messageRowIds;
  }, [messageRowIds]);
  const [rowArrivals, setRowArrivals] = useState<RowArrivalState | null>(null);
  const [, setRowArrivalExpiryTick] = useState(0);
  const nextRowArrivals = advanceRowArrivals(rowArrivals, {
    threadId,
    rowIds: messageRowIds,
    isWorking,
    followNextTailNonce,
    now: Date.now(),
  });
  if (nextRowArrivals !== rowArrivals) setRowArrivals(nextRowArrivals);
  const enteringRowIds = nextRowArrivals.entering;
  useEffect(() => {
    if (enteringRowIds.size === 0) return;
    const firstExpiry = Math.min(...enteringRowIds.values());
    const timer = window.setTimeout(
      () => setRowArrivalExpiryTick((tick) => tick + 1),
      Math.max(0, firstExpiry - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [enteringRowIds]);

  const rowCount = rows.length;
  useEffect(() => {
    // The empty pane has no list. Keep its initial measured end target armed
    // until LegendList actually mounts, including after loading a thread.
    if (rowCount === 0) {
      setInitialScrollAtEndEnabled(isAtEndRef.current);
      return;
    }
    if (!initialScrollAtEndEnabled) return;
    let cancelled = false;
    const scrollGeneration = manualScrollGenerationRef.current;
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      void settleListScroll(
        list,
        () =>
          cancelled ||
          manualScrollGenerationRef.current !== scrollGeneration ||
          listRef.current !== list,
      ).then(() => {
        if (!cancelled) setInitialScrollAtEndEnabled(false);
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [initialScrollAtEndEnabled, listRef, rowCount]);
  const lastRowId = rowCount > 0 ? (rows[rowCount - 1]?.id ?? null) : null;
  const entryRowIndexMap = useMemo(
    () =>
      buildTimelineEntryRowIndexMap(
        rows.map((row) => ({
          id: row.id,
          ...(row.kind === "work"
            ? { groupedEntryIds: row.groupedEntries.map((entry) => entry.id) }
            : {}),
        })),
      ),
    [rows],
  );
  const onEntryRowIndexMapCommitRef = useRef(onEntryRowIndexMapCommit);
  useLayoutEffect(() => {
    onEntryRowIndexMapCommitRef.current = onEntryRowIndexMapCommit;
  });
  useLayoutEffect(() => {
    resolvedEntryRowIndexMapRef.current = entryRowIndexMap;
    onEntryRowIndexMapCommitRef.current?.();
    return () => {
      if (resolvedEntryRowIndexMapRef.current === entryRowIndexMap) {
        resolvedEntryRowIndexMapRef.current = null;
      }
    };
  }, [entryRowIndexMap, resolvedEntryRowIndexMapRef]);
  const [activeMinimapRowIndex, setActiveMinimapRowIndex] = useState(0);
  const [lastViewableRowIndex, setLastViewableRowIndex] = useState(-1);
  const [selectedNavigationRowId, setSelectedNavigationRowId] = useState<string | null>(null);
  const pendingViewableRowIndexRef = useRef(0);
  const pendingLastViewableRowIndexRef = useRef(-1);
  const viewabilityFrameRef = useRef(0);
  const historyLoadControllerRef = useRef<AbortController | null>(null);
  const requestOlderHistory = useCallback(() => {
    if (
      !hasOlderHistory ||
      initialScrollAtEndEnabled ||
      isLoadingOlderHistory ||
      hasHistoryLoadError ||
      !onLoadOlderHistory ||
      historyLoadControllerRef.current
    ) {
      return;
    }
    const node = listRef.current?.getScrollableNode?.();
    if (
      !(node instanceof HTMLElement) ||
      (isAtEndRef.current && node.scrollHeight > node.clientHeight + 2)
    )
      return;
    const controller = new AbortController();
    historyLoadControllerRef.current = controller;
    void onLoadOlderHistory(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.warn("Failed to load older thread history.", error);
        }
      })
      .finally(() => {
        if (historyLoadControllerRef.current === controller) {
          historyLoadControllerRef.current = null;
        }
      });
  }, [
    hasHistoryLoadError,
    hasOlderHistory,
    initialScrollAtEndEnabled,
    isLoadingOlderHistory,
    listRef,
    onLoadOlderHistory,
  ]);
  const handleViewableItemsChanged = useCallback<NonNullable<OnViewableItemsChanged<TimelineRow>>>(
    ({ viewableItems }) => {
      const firstVisibleIndex = viewableItems.reduce(
        (minimum, item) => (item.isViewable ? Math.min(minimum, item.index) : minimum),
        Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(firstVisibleIndex)) return;
      const lastVisibleIndex = viewableItems.reduce(
        (maximum, item) => (item.isViewable ? Math.max(maximum, item.index) : maximum),
        -1,
      );
      if (firstVisibleIndex <= 3) requestOlderHistory();
      pendingViewableRowIndexRef.current = firstVisibleIndex;
      pendingLastViewableRowIndexRef.current = lastVisibleIndex;
      if (viewabilityFrameRef.current !== 0) return;
      viewabilityFrameRef.current = window.requestAnimationFrame(() => {
        viewabilityFrameRef.current = 0;
        setActiveMinimapRowIndex(pendingViewableRowIndexRef.current);
        setLastViewableRowIndex(pendingLastViewableRowIndexRef.current);
      });
    },
    [requestOlderHistory],
  );
  // Finishing initial placement or an older-history request may leave the same rows
  // visible, so the virtual list need not emit another viewability or scroll event.
  useEffect(() => {
    if (pendingViewableRowIndexRef.current <= 3) requestOlderHistory();
  }, [requestOlderHistory]);
  useEffect(
    () => () => {
      if (viewabilityFrameRef.current !== 0) {
        window.cancelAnimationFrame(viewabilityFrameRef.current);
      }
      historyLoadControllerRef.current?.abort();
      historyLoadControllerRef.current = null;
    },
    [],
  );
  const minimapRowIndices = useMemo(
    () =>
      sampleTimelineMinimapRowIndices({
        rowCount,
        boundaryIndices: rows.flatMap((row, index) =>
          row.kind === "work" ? [entryRowIndexMap.get(row.id) ?? index] : [],
        ),
        activeRowIndex: activeMinimapRowIndex,
      }),
    [activeMinimapRowIndex, entryRowIndexMap, rowCount, rows],
  );
  const turnRailItems = useMemo(() => deriveTimelineTurnRailItems(rows), [rows]);
  const assistantRailItems = useMemo(() => deriveTimelineAssistantRailItems(rows), [rows]);
  const selectedNavigationRowIndex =
    selectedNavigationRowId !== null ? entryRowIndexMap.get(selectedNavigationRowId) : undefined;
  // A jump can leave the preceding row visible above the destination, especially
  // near the end where scrolling is clamped. Highlight the selected destination
  // while it is visible, rather than treating the first visible row as the choice.
  const activeRailRowIndex = railIsAtEnd
    ? Math.max(0, rowCount - 1)
    : selectedNavigationRowIndex !== undefined &&
        selectedNavigationRowIndex >= activeMinimapRowIndex &&
        selectedNavigationRowIndex <= lastViewableRowIndex
      ? selectedNavigationRowIndex
      : activeMinimapRowIndex;
  const assistantRailRowIndices = useMemo(
    () => assistantRailItems.map((item) => item.rowIndex),
    [assistantRailItems],
  );
  const assistantRailActiveTickIndex = resolveActiveTurnRailIndex(
    assistantRailRowIndices,
    activeRailRowIndex,
  );
  const turnRailRowIndices = useMemo(
    () => turnRailItems.map((item) => item.rowIndex),
    [turnRailItems],
  );
  const turnRailActiveTickIndex = resolveActiveTurnRailIndex(
    turnRailRowIndices,
    activeRailRowIndex,
  );
  const [turnRailHasPersistentGutter, setTurnRailHasPersistentGutter] = useState(false);
  const [turnRailHitStripWidth, setTurnRailHitStripWidth] = useState(0);
  const [userRailHasPersistentGutter, setUserRailHasPersistentGutter] = useState(false);
  const [userRailHitStripWidth, setUserRailHitStripWidth] = useState(0);

  // Follow later tail advances while the user is at the end. A newly mounted
  // list keeps LegendList's measured initial end target.
  const previousTailSignatureRef = useRef<{
    rowCount: number;
    lastRowId: string | null;
  }>({
    rowCount,
    lastRowId,
  });
  const followedTailNonceRef = useRef(followNextTailNonce);
  useEffect(() => {
    const previousTailSignature = previousTailSignatureRef.current;
    const nextTailSignature = {
      rowCount,
      lastRowId,
    };
    previousTailSignatureRef.current = nextTailSignature;

    const didAdvanceTail =
      nextTailSignature.rowCount > previousTailSignature.rowCount ||
      nextTailSignature.lastRowId !== previousTailSignature.lastRowId;
    // A follow request is honored even if `isAtEndRef` was cleared since the
    // layout effect below set it: the send's own animated scroll can emit
    // scroll events from the old position before this passive effect runs.
    const followRequested = followedTailNonceRef.current !== followNextTailNonce;
    followedTailNonceRef.current = followNextTailNonce;
    const shouldAutoFollow =
      followRequested || (didAdvanceTail && isAtEndRef.current && liveFollowEnabledRef.current);
    if (!shouldAutoFollow) {
      return;
    }

    let frame = 0;
    let cancelled = false;
    const scrollGeneration = manualScrollGenerationRef.current;
    const scrollToEndWhenReady = () => {
      if (cancelled || manualScrollGenerationRef.current !== scrollGeneration) {
        return;
      }
      const list = listRef.current;
      if (!list) {
        frame = window.requestAnimationFrame(scrollToEndWhenReady);
        return;
      }
      isAtEndRef.current = true;
      // The first nonempty render mounts LegendList. Its initialScrollAtEnd
      // uses measured heights; scrollToEnd would replace it with an estimate.
      // Explicit sends jump directly to the tail even across a long history.
      if (followRequested || previousTailSignature.rowCount > 0) {
        list.scrollToEnd?.({ animated: !followRequested });
      }
      onIsAtEndChange(true);
    };
    frame = window.requestAnimationFrame(scrollToEndWhenReady);

    return () => {
      cancelled = true;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [followNextTailNonce, lastRowId, listRef, onIsAtEndChange, rowCount]);

  // Runs before the tail-follow effect above, so rows committed together with
  // the nonce (a bootstrap send's optimistic row) are followed too.
  const followNextTailNonceRef = useRef(followNextTailNonce);
  useLayoutEffect(() => {
    if (followNextTailNonceRef.current === followNextTailNonce) return;
    followNextTailNonceRef.current = followNextTailNonce;
    setSelectedNavigationRowId(null);
    isAtEndRef.current = true;
  }, [followNextTailNonce]);

  const syncIsAtEndFromListState = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      // LegendList's public `isAtEnd` flag can lag behind passive layout
      // changes, but its exposed scroll metrics stay current.
      const node = listRef.current?.getScrollableNode?.();
      const isAtEnd =
        node instanceof HTMLElement && node.clientHeight > 0
          ? node.scrollHeight - node.scrollTop - node.clientHeight < TIMELINE_AT_END_PX
          : state.contentLength < state.scrollLength || timelineIsAtEnd(state);
      setRailIsAtEnd(isAtEnd);
      // Content growth can briefly outrun LegendList's layout correction.
      // Reaching the bottom never enables following: only the explicit switch does.
      isAtEndRef.current = isAtEnd || liveFollowEnabledRef.current;
      onIsAtEndChange(isAtEndRef.current);
    }
  }, [listRef, onIsAtEndChange]);

  const measureTurnRailGutter = useCallback(() => {
    const node = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement)) return;
    setAtEndThreshold(node.clientHeight > 0 ? TIMELINE_AT_END_PX / node.clientHeight : 0);
    // Measure rendered geometry so scrollbars, responsive padding, and zoom
    // cannot make the hit target overlap the content column.
    const column = node.querySelector<HTMLElement>('[data-timeline-root="true"]');
    if (!column) return;
    const gutterPx = column.getBoundingClientRect().left - node.getBoundingClientRect().left;
    // Keep the existing scroll minimap's 20px strip clear on the far right.
    const rightGutterPx =
      node.getBoundingClientRect().left +
      node.clientLeft +
      node.clientWidth -
      column.getBoundingClientRect().right -
      20;
    setTurnRailHasPersistentGutter((current) => {
      const next = resolveTimelineTurnRailHasPersistentGutter(gutterPx);
      return current === next ? current : next;
    });
    setTurnRailHitStripWidth((current) => {
      const next = resolveTimelineTurnRailHitStripWidth(gutterPx);
      return current === next ? current : next;
    });
    setUserRailHasPersistentGutter((current) => {
      const next = resolveTimelineTurnRailHasPersistentGutter(rightGutterPx);
      return current === next ? current : next;
    });
    setUserRailHitStripWidth((current) => {
      const next = resolveTimelineTurnRailHitStripWidth(rightGutterPx);
      return current === next ? current : next;
    });
  }, [listRef]);

  const disclosurePinsEndRef = useRef(false);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  // A jump or scroll away from the end: stop following the tail now, and drop
  // any follow scroll or disclosure pin already queued for a later frame.
  const leaveEnd = useCallback(() => {
    setSelectedNavigationRowId(null);
    onLeaveEnd?.();
    manualScrollGenerationRef.current++;
    isAtEndRef.current = false;
    setRailIsAtEnd(false);
    liveFollowEnabledRef.current = false;
    onAutoFollowChange?.(false);
    disclosurePinsEndRef.current = false;
    if (disclosureSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(disclosureSettleFrameRef.current);
      disclosureSettleFrameRef.current = null;
    }
  }, [onAutoFollowChange, onLeaveEnd]);

  useEffect(() => {
    if (!hasMessages && !isWorking) {
      return;
    }

    let attachFrame = 0;
    let syncFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    const cleanups: Array<() => void> = [];

    const cancelSyncFrame = () => {
      if (syncFrame === 0) {
        return;
      }
      window.cancelAnimationFrame(syncFrame);
      syncFrame = 0;
    };

    const scheduleSyncIsAtEnd = () => {
      if (syncFrame !== 0) {
        return;
      }
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = 0;
        syncIsAtEndFromListState();
        measureTurnRailGutter();
      });
    };

    const attachBottomStateListeners = () => {
      const list = listRef.current;
      const state = list?.getState?.();
      if (!list || !state) {
        attachFrame = window.requestAnimationFrame(attachBottomStateListeners);
        return;
      }

      cleanups.push(state.listen("totalSize", scheduleSyncIsAtEnd));
      cleanups.push(state.listen("headerSize", scheduleSyncIsAtEnd));
      cleanups.push(state.listen("footerSize", scheduleSyncIsAtEnd));

      const scrollableNode = list.getScrollableNode?.();
      if (scrollableNode instanceof HTMLElement) {
        const cancelFollow = () => {
          if (scrollableNode.scrollHeight <= scrollableNode.clientHeight) return;
          leaveEnd();
        };
        const wheel = (event: WheelEvent) => {
          if (event.deltaY !== 0) setSelectedNavigationRowId(null);
          if (event.deltaY < 0) {
            cancelFollow();
            if (pendingViewableRowIndexRef.current <= 3) requestOlderHistory();
          }
        };
        const keydown = (event: KeyboardEvent) => {
          if (
            ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)
          ) {
            setSelectedNavigationRowId(null);
          }
          if (
            ["PageUp", "Home", "ArrowUp"].includes(event.key) ||
            (event.key === " " && event.shiftKey)
          ) {
            cancelFollow();
            if (pendingViewableRowIndexRef.current <= 3) requestOlderHistory();
          }
        };
        const pointerdown = (event: PointerEvent) => {
          if (event.target === scrollableNode) cancelFollow();
        };
        let lastTouchY: number | null = null;
        const touchstart = (event: TouchEvent) => {
          lastTouchY = event.touches[0]?.clientY ?? null;
        };
        const touchmove = (event: TouchEvent) => {
          setSelectedNavigationRowId(null);
          const y = event.touches[0]?.clientY ?? null;
          const movingUp = y !== null && lastTouchY !== null && y > lastTouchY;
          lastTouchY = y;
          const state = list.getState?.();
          if (movingUp || (state && !timelineIsAtEnd(state))) cancelFollow();
          if (movingUp && pendingViewableRowIndexRef.current <= 3) requestOlderHistory();
        };
        scrollableNode.addEventListener("wheel", wheel, { passive: true });
        scrollableNode.addEventListener("keydown", keydown);
        scrollableNode.addEventListener("pointerdown", pointerdown, { passive: true });
        scrollableNode.addEventListener("touchstart", touchstart, { passive: true });
        scrollableNode.addEventListener("touchmove", touchmove, { passive: true });
        cleanups.push(() => {
          scrollableNode.removeEventListener("wheel", wheel);
          scrollableNode.removeEventListener("keydown", keydown);
          scrollableNode.removeEventListener("pointerdown", pointerdown);
          scrollableNode.removeEventListener("touchstart", touchstart);
          scrollableNode.removeEventListener("touchmove", touchmove);
        });
      }
      if (typeof ResizeObserver !== "undefined" && scrollableNode instanceof HTMLElement) {
        resizeObserver = new ResizeObserver(() => {
          scheduleSyncIsAtEnd();
        });
        resizeObserver.observe(scrollableNode);
      }

      scheduleSyncIsAtEnd();
    };

    attachBottomStateListeners();
    return () => {
      if (attachFrame !== 0) {
        window.cancelAnimationFrame(attachFrame);
      }
      cancelSyncFrame();
      resizeObserver?.disconnect();
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    hasMessages,
    isWorking,
    leaveEnd,
    listRef,
    measureTurnRailGutter,
    requestOlderHistory,
    syncIsAtEndFromListState,
  ]);

  useLayoutEffect(() => {
    if (!threadId || !hasMessages) return;
    const node = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement)) return;
    let frame = 0;
    const remember = () => {
      frame = 0;
      timelineScrollAnchors.set(threadId, readTimelineScrollAnchor(node));
    };
    const onScroll = (event: Event) => {
      // Code blocks and nested diff panes must not replace the conversation anchor.
      if (event.target !== node || frame) return;
      frame = window.requestAnimationFrame(remember);
    };
    node.addEventListener("scroll", onScroll);
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      remember();
    };
  }, [threadId, hasMessages, listRef]);

  const handleScroll = useCallback(() => {
    syncIsAtEndFromListState();
    if (!isAtEndRef.current && pendingViewableRowIndexRef.current <= 3) requestOlderHistory();
  }, [requestOlderHistory, syncIsAtEndFromListState]);

  // A disclosure toggled at the end keeps the end in view while rows re-measure.
  // Anywhere else, maintainVisibleContentPosition holds the toggled row in place.
  const pinDisclosureToEnd = useCallback(() => {
    if (!disclosurePinsEndRef.current) return;
    const node = listRef.current?.getScrollableNode?.();
    if (node instanceof HTMLElement) node.scrollTop = node.scrollHeight;
  }, [listRef]);
  // Settles two frames after the last toggle or row resize, since tool output
  // can render a few frames late.
  const scheduleDisclosureSettle = useCallback(() => {
    if (disclosureSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    disclosureSettleFrameRef.current = window.requestAnimationFrame(() => {
      pinDisclosureToEnd();
      disclosureSettleFrameRef.current = window.requestAnimationFrame(() => {
        pinDisclosureToEnd();
        disclosurePinsEndRef.current = false;
        disclosureSettleFrameRef.current = null;
        syncIsAtEndFromListState();
      });
    });
  }, [pinDisclosureToEnd, syncIsAtEndFromListState]);
  const pinEndThroughDisclosure = useCallback(() => {
    if (!isAtEndRef.current) return;
    disclosurePinsEndRef.current = true;
    scheduleDisclosureSettle();
  }, [scheduleDisclosureSettle]);
  const handleItemSizeChanged = useCallback(() => {
    if (!disclosurePinsEndRef.current) return;
    queueMicrotask(pinDisclosureToEnd);
    scheduleDisclosureSettle();
  }, [pinDisclosureToEnd, scheduleDisclosureSettle]);
  useEffect(
    () => () => {
      if (disclosureSettleFrameRef.current !== null) {
        window.cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!leaveEndRef) return;
    leaveEndRef.current = leaveEnd;
    return () => {
      if (leaveEndRef.current === leaveEnd) leaveEndRef.current = null;
    };
  }, [leaveEnd, leaveEndRef]);
  const navigateToTimelineRow = useCallback(
    (rowIndex: number, viewPosition: number) => {
      leaveEnd();
      onIsAtEndChange(false);
      void listRef.current?.scrollToIndex({
        index: rowIndex,
        animated: false,
        viewPosition,
      });
    },
    [leaveEnd, listRef, onIsAtEndChange],
  );
  // Rail, minimap, popover and revert jumps go through the navigation owner
  // by row id, so they cancel pending find placement like any other jump.
  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  });
  const navigateToRow = useCallback(
    (rowIndex: number, viewPosition: number) => {
      const rowId = rowsRef.current[rowIndex]?.id;
      if (onNavigateToEntry && rowId !== undefined) onNavigateToEntry(rowId, viewPosition);
      else navigateToTimelineRow(rowIndex, viewPosition);
    },
    [navigateToTimelineRow, onNavigateToEntry],
  );

  const navigationStore = useState(createConversationNavigationStore)[0];
  useEffect(() => {
    if (!navigationHost) return;
    navigationStore.publish({
      items: turnRailItems,
      activeIndex: turnRailActiveTickIndex,
      hasOlderHistory,
      isLoadingOlderHistory,
      hasHistoryLoadError,
    });
  }, [
    hasHistoryLoadError,
    hasOlderHistory,
    isLoadingOlderHistory,
    navigationHost,
    navigationStore,
    turnRailActiveTickIndex,
    turnRailItems,
  ]);
  // By row id: a popover snapshot's row index can be one render stale after
  // older history is prepended.
  const selectNavigationTurn = useCallback(
    (item: TimelineTurnRailItem) => {
      if (onNavigateToEntry) onNavigateToEntry(item.id, 0.1);
      else navigateToRow(item.rowIndex, 0.1);
      setSelectedNavigationRowId(item.id);
    },
    [navigateToRow, onNavigateToEntry],
  );
  const loadOlderHistoryFromNavigation = useCallback(() => {
    if (!onLoadOlderHistory || historyLoadControllerRef.current) return;
    const controller = new AbortController();
    historyLoadControllerRef.current = controller;
    void onLoadOlderHistory(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("Failed to load older thread history.", error);
      })
      .finally(() => {
        if (historyLoadControllerRef.current === controller)
          historyLoadControllerRef.current = null;
      });
  }, [onLoadOlderHistory]);

  const forwardOverlayWheel = useCallback(
    (event: WheelEvent) => {
      if (event.deltaY !== 0) setSelectedNavigationRowId(null);
      const node = listRef.current?.getScrollableNode?.();
      if (node instanceof HTMLElement) forwardWheelToTimeline(event, node);
    },
    [listRef],
  );

  const keyExtractor = useCallback((row: TimelineRow) => row.id, []);

  // Revert popover state lives here, not in the row: LegendList recycles rows,
  // and the timeline also dims everything the open popover would remove.
  const [revertPopover, setRevertPopover] = useState<{
    messageId: MessageId;
    presetRestoreFiles?: boolean;
    /**
     * The thread's newest message when the popover opened. The server rejects
     * the revert if anything arrived after it, so the user never removes
     * messages they did not see while deciding.
     */
    expectedLatestMessageId: MessageId | null;
  } | null>(null);
  const timelineMessages = useMemo(
    () => timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    [timelineEntries],
  );
  const revertImpact = useMemo(
    () =>
      revertPopover
        ? computeRevertImpact(timelineMessages, revertPopover.messageId, turnDiffSummaryByTurnId)
        : null,
    [revertPopover, timelineMessages, turnDiffSummaryByTurnId],
  );
  // The parent knows the specific reason (sending, connecting, agent running);
  // `isWorking` is only a fallback for callers that don't pass one.
  const effectiveRevertDisabledReason = isRevertingCheckpoint
    ? "A revert is already in progress"
    : (revertDisabledReason ?? (isWorking ? "Wait for the agent to finish to revert" : null));
  const revertDimMessageId = pendingRevert?.targetMessageId ?? revertPopover?.messageId ?? null;
  const revertDimFromRowIndex = useMemo(
    () =>
      revertDimMessageId === null
        ? -1
        : rows.findIndex((row) => row.kind === "message" && row.message.id === revertDimMessageId),
    [revertDimMessageId, rows],
  );
  // A reopen request is consumed as soon as it is seen, so remounting the
  // timeline (thread switch) can never replay it. It is dropped, not deferred,
  // when revert is unavailable: opening later, unprompted, would be a surprise.
  useEffect(() => {
    if (!revertReopenRequest) return;
    onRevertReopenHandled?.(revertReopenRequest.nonce);
    if (effectiveRevertDisabledReason !== null) return;
    const rowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === revertReopenRequest.messageId,
    );
    if (rowIndex < 0) return;
    navigateToRow(rowIndex, 0.3);
    setRevertPopover({
      messageId: revertReopenRequest.messageId,
      presetRestoreFiles: revertReopenRequest.restoreFiles,
      expectedLatestMessageId: latestMessageId,
    });
    // Keyed on the nonce alone: only a new request should trigger this, and the
    // other inputs are deliberately read as of that moment.
  }, [revertReopenRequest?.nonce]);
  // A popover whose message disappeared (reverted, thread switched) must not linger.
  useEffect(() => {
    if (revertPopover && !timelineMessages.some((m) => m.id === revertPopover.messageId))
      setRevertPopover(null);
  }, [revertPopover, timelineMessages]);

  const ribbonActive = ribbonOrigin !== null;
  // Row actions call the latest props through this ref, so their identities
  // never change and ChatView re-renders do not invalidate memoized rows.
  const latestRowInputs = {
    onToggleWorkGroup,
    onSetWorkGroupExpanded,
    onOpenTurnDiff,
    onImageExpand,
    onImageActionMenu,
    onToggleCommandExecution,
    onToggleAllDirectories,
    onRevertUserMessage,
    latestMessageId,
    revertPopover,
    chatDiffContext,
    pinEndThroughDisclosure,
    onQuoteAssistantMessage,
  };
  const latestRowInputsRef = useRef(latestRowInputs);
  useLayoutEffect(() => {
    latestRowInputsRef.current = latestRowInputs;
  });
  const rowActions = useMemo<TimelineRowActions>(
    () => ({
      onToggleWorkGroup: (groupId, paginatedEntryCount) => {
        latestRowInputsRef.current.pinEndThroughDisclosure();
        latestRowInputsRef.current.onToggleWorkGroup(groupId, paginatedEntryCount);
      },
      onSetWorkGroupExpanded: (groupId, expanded) => {
        latestRowInputsRef.current.pinEndThroughDisclosure();
        latestRowInputsRef.current.onSetWorkGroupExpanded?.(groupId, expanded);
      },
      onOpenTurnDiff: (turnId, filePath) =>
        latestRowInputsRef.current.onOpenTurnDiff(turnId, filePath),
      onImageExpand: (preview) => latestRowInputsRef.current.onImageExpand(preview),
      onImageActionMenu: (item, position) =>
        latestRowInputsRef.current.onImageActionMenu?.(item, position),
      onToggleCommandExecution: (commandExecutionId) => {
        latestRowInputsRef.current.pinEndThroughDisclosure();
        latestRowInputsRef.current.onToggleCommandExecution(commandExecutionId);
      },
      onToggleAllDirectories: () => {
        latestRowInputsRef.current.pinEndThroughDisclosure();
        latestRowInputsRef.current.onToggleAllDirectories();
      },
      onToggleFileChangeDiff: (workEntryId) => {
        latestRowInputsRef.current.pinEndThroughDisclosure();
        latestRowInputsRef.current.chatDiffContext.onToggleFileChangeDiff(workEntryId);
      },
      onOpenFileChangeDiff: (fileChangeId, filePath) =>
        latestRowInputsRef.current.chatDiffContext.onOpenFileChangeDiff(fileChangeId, filePath),
      setRevertPopoverOpen: (messageId, open) =>
        setRevertPopover((current) =>
          open
            ? {
                messageId,
                expectedLatestMessageId: latestRowInputsRef.current.latestMessageId,
              }
            : current?.messageId === messageId
              ? null
              : current,
        ),
      confirmRevert: (messageId, restoreFiles) => {
        const latest = latestRowInputsRef.current;
        latest.onRevertUserMessage(
          messageId,
          restoreFiles,
          latest.revertPopover?.messageId === messageId
            ? latest.revertPopover.expectedLatestMessageId
            : latest.latestMessageId,
        );
      },
      setChangedFilesPresentationOverrides,
      startRibbon: (origin) => setRibbonOrigin(origin),
      quoteAssistantMessage: (messageId, text) =>
        latestRowInputsRef.current.onQuoteAssistantMessage?.(messageId, text),
    }),
    [],
  );
  const rowChatDiffContext = useMemo<ChatDiffContext>(
    () => ({
      ...chatDiffContext,
      onToggleFileChangeDiff: rowActions.onToggleFileChangeDiff,
      onOpenFileChangeDiff: rowActions.onOpenFileChangeDiff,
    }),
    [chatDiffContext, rowActions],
  );
  const timelineRowContext = useMemo<TimelineRowContextValue>(
    () => ({
      threadId,
      nativeSessionCapabilities: nativeSessionCapabilities ?? null,
      expandMcpToolCalls: settings.expandMcpToolCalls,
      expandMcpToolCallCardsByDefault: settings.expandMcpToolCallCardsByDefault,
      showReasoningExpanded: settings.showReasoningExpanded,
      showFileChangeDiffsInline: settings.showFileChangeDiffsInline,
      collapseCompletedWorkLogs: settings.collapseCompletedWorkLogs,
      timestampFormat,
      workspaceRoot,
      markdownCwd,
      resolvedTheme,
      isGitRepo: chatDiffContext.isGitRepo,
      promptLinkRepository: chatDiffContext.promptLinkRepository ?? null,
      canRestoreFiles,
      revertDisabledReason: effectiveRevertDisabledReason,
      revertPreferenceKey,
      allDirectoriesExpanded,
      usesCustomImageContextMenu,
      hasImageActionMenu: onImageActionMenu !== undefined,
      canSetWorkGroupExpanded: onSetWorkGroupExpanded !== undefined,
      isWorking,
      reducedMotion,
      userMessageMarkup: settings.composerRichTextEnabled,
      canQuoteAssistantMessages: onQuoteAssistantMessage !== undefined,
      grabButtonRef,
      actions: rowActions,
    }),
    [
      allDirectoriesExpanded,
      canRestoreFiles,
      onQuoteAssistantMessage,
      settings.composerRichTextEnabled,
      chatDiffContext.isGitRepo,
      chatDiffContext.promptLinkRepository,
      effectiveRevertDisabledReason,
      isWorking,
      markdownCwd,
      nativeSessionCapabilities,
      onImageActionMenu,
      onSetWorkGroupExpanded,
      reducedMotion,
      resolvedTheme,
      revertPreferenceKey,
      rowActions,
      settings.collapseCompletedWorkLogs,
      settings.expandMcpToolCallCardsByDefault,
      settings.expandMcpToolCalls,
      settings.showFileChangeDiffsInline,
      settings.showReasoningExpanded,
      threadId,
      timestampFormat,
      usesCustomImageContextMenu,
      workspaceRoot,
    ],
  );
  const committedRowExternalsRef = useRef<{
    readonly externals: ReadonlyMap<string, TimelineRowExternalsEntry>;
    readonly basis?: TimelineRowExternalsBasis;
  }>({ externals: new Map() });
  const rowExternalsState = useMemo(() => {
    const basis: TimelineRowExternalsBasis = {
      rows,
      inputs: {
        threadId,
        expandedWorkGroups,
        workGroupCollapseOverrides,
        turnDiffSummaryByTurnId,
        chatDiffContext: rowChatDiffContext,
        revertTurnCountByUserMessageId,
        revertPopover,
        revertImpact,
        turnDiffSummaryByAssistantMessageId,
        cacheMissByAssistantMessageId,
        changedFilesPresentationOverrides,
        newestTurnDiffId,
        expandedCommandExecutions,
        ribbonActive,
      },
    };
    const committed = committedRowExternalsRef.current;
    return {
      basis,
      externals: buildTimelineRowExternals(
        basis.rows,
        basis.inputs,
        committed.externals,
        committed.basis,
      ),
    };
  }, [
    cacheMissByAssistantMessageId,
    changedFilesPresentationOverrides,
    expandedCommandExecutions,
    expandedWorkGroups,
    newestTurnDiffId,
    revertImpact,
    revertPopover,
    revertTurnCountByUserMessageId,
    ribbonActive,
    rowChatDiffContext,
    rows,
    threadId,
    turnDiffSummaryByAssistantMessageId,
    turnDiffSummaryByTurnId,
    workGroupCollapseOverrides,
  ]);
  const rowExternals = rowExternalsState.externals;
  useLayoutEffect(() => {
    committedRowExternalsRef.current = rowExternalsState;
  }, [rowExternalsState]);
  // LegendList caches cell renders until `data` or `extraData` changes, so
  // every value `renderItem` reads must be here: the revert dimming and the
  // per-row externals map (a new map only when some row's inputs changed).
  // Slow-changing values reach rows through context instead.
  const legendListExtraData = useMemo(
    () => [revertDimFromRowIndex, pendingRevert, rowExternals],
    [pendingRevert, revertDimFromRowIndex, rowExternals],
  );
  // LegendList's internal dataset tracking can miss row-shape changes during
  // sequential live updates, so each row contributes its identity (a new row
  // object means new content) and its external-input version.
  const legendListDataVersion = useMemo(
    () =>
      rows
        .map(
          (row) =>
            `${row.id}#${timelineObjectVersion(row)}#${rowExternals.get(row.id)?.version ?? ""}`,
        )
        .join("|"),
    [rowExternals, rows],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: TimelineRow; index: number }) => {
      // Rows from the revert target onward: previewed while the popover is open,
      // then held dimmed and inert until the revert lands and removes them.
      const dimmed = revertDimFromRowIndex >= 0 && index >= revertDimFromRowIndex;
      const reverting = dimmed && pendingRevert !== null;
      const externalsEntry = rowExternals.get(item.id);
      return (
        // Keep `overflow-x-clip`: `hidden` computes `overflow-y: auto`, so ChangedFilesTree would
        // take this row as its scroller and mount every row of a large tree.
        <div
          className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width) overflow-x-clip"
          data-timeline-root="true"
        >
          {pendingRevert && index === revertDimFromRowIndex ? (
            <RevertStatusPill label={pendingRevert.label} />
          ) : null}
          <div
            className={cn(
              "transition-opacity duration-150 motion-reduce:transition-none",
              dimmed && "opacity-50",
              reverting && "pointer-events-none select-none opacity-40",
            )}
            data-revert-dimmed={dimmed ? "" : undefined}
            aria-busy={reverting || undefined}
          >
            {externalsEntry ? (
              <TimelineRowView
                row={item}
                externals={externalsEntry.externals}
                rowVersion={externalsEntry.version}
              />
            ) : null}
          </div>
        </div>
      );
    },
    [pendingRevert, revertDimFromRowIndex, rowExternals],
  );

  // Portalled into the header: turn data never passes through header props.
  const navigationControl = navigationHost
    ? createPortal(
        <ConversationNavigation
          store={navigationStore}
          disabled={!hasMessages}
          timestampFormat={timestampFormat}
          onSelectTurn={selectNavigationTurn}
          onOpenFind={onOpenThreadFind}
          onLoadOlderHistory={onLoadOlderHistory ? loadOlderHistoryFromNavigation : undefined}
          onRetryOlderHistory={onRetryOlderHistory}
        />,
        navigationHost,
      )
    : null;

  if (!hasMessages && !isWorking) {
    // Render the header slot above the empty-state message so that any
    // ThreadTasksPanel passed in by ChatView still shows on threads that have
    // tasks but no timeline rows yet (e.g. freshly loaded detail before the
    // first message arrives). Without this branch, passing the tasks panel
    // through `listHeaderContent` would silently drop it on empty threads.
    return (
      <div
        className="flex h-full flex-col overflow-y-auto overscroll-y-contain pl-3 pr-10 pb-(--composer-dock-height) sm:pl-5"
        data-slot="messages-scroll-container"
      >
        {listHeaderContent ? <div className="pt-3 sm:pt-4">{listHeaderContent}</div> : null}
        <MessagesTimelineEmpty emptyState={emptyState} />
        {navigationControl}
      </div>
    );
  }

  return (
    <TimelineRowContext.Provider value={timelineRowContext}>
      <RowEnteringContext value={enteringRowIds}>
        <TooltipScrollDismissArea className="relative h-full min-h-0">
          <LegendList<TimelineRow>
            ref={listRef}
            data={rows}
            // LegendList's internal dataset tracking can miss row-shape changes
            // during sequential live updates unless we provide an explicit version.
            // That includes both mid-stream insertions and later layout-affecting
            // changes like response dividers or inline file diffs becoming eligible.
            dataVersion={legendListDataVersion}
            keyExtractor={keyExtractor}
            getItemType={getTimelineItemType}
            renderItem={renderItem}
            // LegendList caches row renders until either the backing data or
            // extraData changes, so closure-only UI state must flow through here.
            extraData={legendListExtraData}
            estimatedItemSize={90}
            drawDistance={336}
            // Keep LegendList's bootstrap "start at end" behavior for the initial
            // mount only. Leaving this enabled on later data updates causes the web
            // implementation to re-arm its initial-scroll logic and jump away from
            // historical file-change rows during optimistic sends.
            initialScrollAtEnd={initialScrollAtEndEnabled}
            {...(restoredAnchor && !restoredAnchor.atEnd
              ? rows.some((row) => row.id === restoredAnchor.rowId)
                ? {
                    initialScrollIndex: {
                      index: rows.findIndex((row) => row.id === restoredAnchor.rowId),
                      viewPosition: 0,
                      viewOffset: restoredAnchor.top,
                    },
                  }
                : { initialScrollOffset: restoredAnchor.scroll }
              : {})}
            // Do not auto-pin on raw data appends. When the user is looking at a
            // historical file-change diff near the tail of the thread, a new user
            // turn and its first assistant progress messages should preserve that
            // viewport instead of snapping to the latest row. We still keep
            // size/layout-based pinning so streaming growth at the tail continues to
            // follow when the user is already at the end.
            maintainScrollAtEnd={
              liveFollowEnabled ? { on: { itemLayout: true, layout: true } } : false
            }
            maintainScrollAtEndThreshold={atEndThreshold}
            // Stabilize the visible window both when rows resize and when a new user
            // turn appends data. Without `data: true`, historical work rows can drop
            // out of the rendered window during live chat updates even though the
            // row data itself is still present.
            maintainVisibleContentPosition={{ size: true, data: true }}
            onScroll={handleScroll}
            onItemSizeChanged={handleItemSizeChanged}
            onViewableItemsChanged={handleViewableItemsChanged}
            // Stable hook for browser tests
            // queries — the LegendList's overflow container has inline styles that
            // make class-based selectors fragile.
            data-slot="messages-scroll-container"
            className="h-full overflow-x-hidden overscroll-y-contain pl-3 pr-10 sm:pl-5"
            ListHeaderComponent={
              <>
                <div className="h-3 sm:h-4" />
                {listHeaderContent}
              </>
            }
            // Reserves room for the floating composer dock so the last row
            // scrolls fully clear of it.
            ListFooterComponent={
              <ComposerDockSpacer className="h-[calc(var(--composer-dock-height,0px)+0.75rem)] sm:h-[calc(var(--composer-dock-height,0px)+1rem)]" />
            }
          />
          {/* Outside the virtualized list so scrolling and cell recycling never unmount it. */}
          {ribbonOrigin && isWorking ? (
            <LiveWorkingRibbon
              startedAt={activeTurnStartedAt}
              origin={ribbonOrigin}
              onRelease={handleRibbonRelease}
              onOrphanedFocus={restoreRibbonFocus}
            />
          ) : null}
          {minimapRowIndices.length > 1 ? (
            <TimelineMinimap
              rows={rows}
              markerRowIndices={minimapRowIndices}
              activeRowIndex={activeMinimapRowIndex}
              hasUnloadedHistory={hasOlderHistory}
              onNavigate={(rowIndex) => navigateToRow(rowIndex, 0.3)}
              onWheel={forwardOverlayWheel}
            />
          ) : null}
          {turnRailItems.length >= TIMELINE_TURN_RAIL_MIN_ITEMS ? (
            <TimelineTurnRail
              items={turnRailItems}
              side="right"
              target="user"
              hasPersistentGutter={userRailHasPersistentGutter}
              hitStripWidth={userRailHitStripWidth}
              activeTickIndex={turnRailActiveTickIndex}
              onSelect={selectNavigationTurn}
              onWheel={forwardOverlayWheel}
            />
          ) : null}
          {assistantRailItems.length >= TIMELINE_TURN_RAIL_MIN_ITEMS ? (
            <TimelineTurnRail
              items={assistantRailItems}
              side="left"
              target="assistant"
              hasPersistentGutter={turnRailHasPersistentGutter}
              hitStripWidth={turnRailHitStripWidth}
              activeTickIndex={assistantRailActiveTickIndex}
              onSelect={selectNavigationTurn}
              onWheel={forwardOverlayWheel}
            />
          ) : null}
          {navigationControl}
        </TooltipScrollDismissArea>
      </RowEnteringContext>
    </TimelineRowContext.Provider>
  );
});

function TimelineMinimap(props: {
  rows: ReadonlyArray<TimelineRow>;
  markerRowIndices: ReadonlyArray<number>;
  activeRowIndex: number;
  hasUnloadedHistory: boolean;
  onNavigate: (rowIndex: number) => void;
  onWheel: (event: WheelEvent) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { onWheel } = props;
  const setTrackRef = useCallback(
    (node: HTMLDivElement | null) => {
      trackRef.current = node;
      if (!node) return;
      node.addEventListener("wheel", onWheel, { passive: false });
      return () => {
        node.removeEventListener("wheel", onWheel);
        trackRef.current = null;
      };
    },
    [onWheel],
  );
  const activeMarkerIndex = findNearestMinimapMarkerIndex(
    props.markerRowIndices,
    props.activeRowIndex,
  );
  const navigateFromClientY = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
      const targetRow = Math.round(ratio * Math.max(0, props.rows.length - 1));
      const markerIndex = findNearestMinimapMarkerIndex(props.markerRowIndices, targetRow);
      const rowIndex = props.markerRowIndices[markerIndex];
      if (rowIndex !== undefined) props.onNavigate(rowIndex);
    },
    [props],
  );

  const turnRows = props.rows.flatMap((row, index) =>
    row.kind === "message" && row.message.role === "user" ? [index] : [],
  );
  const previousTurn = turnRows.findLast((index) => index < props.activeRowIndex);
  const nextTurn = turnRows.find((index) => index > props.activeRowIndex);
  return (
    <>
      <button
        type="button"
        aria-label="Previous turn"
        title="Previous turn"
        disabled={previousTurn === undefined}
        onClick={() => {
          if (previousTurn !== undefined) props.onNavigate(previousTurn);
        }}
        className="absolute right-0 top-0 z-10 rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-25"
      >
        <ChevronDownIcon className="size-3 rotate-180" />
      </button>
      <button
        type="button"
        aria-label="Next turn"
        title="Next turn"
        disabled={nextTurn === undefined}
        onClick={() => {
          if (nextTurn !== undefined) props.onNavigate(nextTurn);
        }}
        className="absolute right-0 bottom-0 z-10 rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-25"
      >
        <ChevronDownIcon className="size-3" />
      </button>
      <div
        ref={setTrackRef}
        className="absolute top-5 right-1 bottom-5 z-10 w-3 touch-none rounded-full bg-background/70 opacity-45 backdrop-blur-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
        role="slider"
        tabIndex={0}
        aria-label="Conversation minimap"
        title={
          props.hasUnloadedHistory
            ? "Loaded conversation range; scroll upward to load earlier history"
            : "Full conversation"
        }
        aria-valuemin={0}
        aria-valuemax={Math.max(0, props.rows.length - 1)}
        aria-valuenow={props.activeRowIndex}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          navigateFromClientY(event.clientY);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            navigateFromClientY(event.clientY);
          }
        }}
        onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        onKeyDown={(event) => {
          let markerIndex = activeMarkerIndex;
          if (event.key === "ArrowDown" || event.key === "PageDown") markerIndex += 1;
          else if (event.key === "ArrowUp" || event.key === "PageUp") markerIndex -= 1;
          else if (event.key === "Home") markerIndex = 0;
          else if (event.key === "End") markerIndex = props.markerRowIndices.length - 1;
          else return;
          event.preventDefault();
          const rowIndex =
            props.markerRowIndices[
              Math.min(props.markerRowIndices.length - 1, Math.max(0, markerIndex))
            ];
          if (rowIndex !== undefined) props.onNavigate(rowIndex);
        }}
      >
        {props.hasUnloadedHistory ? (
          <span className="pointer-events-none absolute top-0 left-1/2 h-1 w-2 -translate-x-1/2 rounded-full border border-dashed border-muted-foreground/70" />
        ) : null}
        {props.markerRowIndices.map((rowIndex, markerIndex) => {
          const row = props.rows[rowIndex];
          if (!row) return null;
          const isActive = markerIndex === activeMarkerIndex;
          return (
            <span
              key={row.id}
              className={cn(
                "pointer-events-none absolute left-1/2 h-px -translate-x-1/2 rounded-full",
                row.kind === "message"
                  ? row.message.role === "user"
                    ? "bg-primary/80"
                    : "bg-foreground/55"
                  : row.kind === "work"
                    ? "bg-warning/70"
                    : "bg-muted-foreground/50",
                isActive ? "w-3 h-0.5 opacity-100" : "w-1.5",
              )}
              style={{ top: `${(rowIndex / Math.max(1, props.rows.length - 1)) * 100}%` }}
            />
          );
        })}
      </div>
    </>
  );
}

/** Marks where the conversation will end while a revert is running. */
function RevertStatusPill({ label }: { label: string }) {
  return (
    <div className="flex justify-center pb-3" role="status" data-slot="revert-status-pill">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-muted-foreground text-xs shadow-xs">
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3 animate-spin motion-reduce:animate-none"
        />
        {label}
      </span>
    </div>
  );
}

// Wraps each row with the DOM attributes that tests and selectors depend on
// (data-timeline-row-id, data-timeline-row-kind, data-message-id, data-message-role).
// Replaces the former `ObservedTimelineRow` — LegendList measures rows
// internally, so the ResizeObserver shim is no longer needed.
const TimelineRowWrapper = memo(function TimelineRowWrapper({
  row,
  compactBottom,
  testRenderCountProps,
  children,
}: {
  row: TimelineRow;
  /** A tool row followed by another tool row. */
  compactBottom: boolean;
  testRenderCountProps?: { "data-render-count": number } | undefined;
  children: ReactNode;
}) {
  // A freshly appended row rises in (a transform, so list measurement is unaffected).
  const entering = useContext(RowEnteringContext).has(row.id);
  const find = useContext(ThreadFindContext);
  const element = useRef<HTMLDivElement>(null);
  const active = find?.entryId === row.id;
  useEffect(() => {
    const root = element.current;
    if (!active || !find || !root) return;
    let clear = () => {};
    let frame = 0;
    let reported = false;
    // Streaming and highlighter mutations only refresh the highlights; the
    // range is reported once so the navigation owner places it a single time.
    const refresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          clear();
          const highlight = highlightThreadFind(root, find.query, find.occurrence);
          clear = highlight.clear;
          // Only the requested occurrence is reported; a stand-in (the first
          // match, while a later block is still rendering) would place the
          // wrong text, and the report happens once.
          if (reported || !highlight.exact || !highlight.selected || find.requestId == null) {
            return;
          }
          reported = true;
          find.onSelectedRange?.(find.requestId, highlight.selected);
        });
      });
    };
    const observer = new MutationObserver(refresh);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    refresh();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      clear();
    };
  }, [active, find]);
  recordTimelineRowRender(row.id);
  return (
    <div
      ref={element}
      data-thread-find-active={active ? "true" : undefined}
      data-row-entering={entering ? "" : undefined}
      className={cn(compactBottom ? "pb-1.5" : "pb-4", entering && "motion-safe:animate-rise")}
      {...testRenderCountProps}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "message" ? (
        <h2 className="sr-only" data-assistant-quote-exclude>
          {row.message.role === "user"
            ? "You"
            : row.message.role === "assistant"
              ? "Assistant"
              : "Message"}
        </h2>
      ) : null}
      {children}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
// Each type has its own measured size average in LegendList. Keep very long
// replies out of the short-reply average to bound synchronous measurement churn.
// Streaming rows intentionally move buckets as they grow; freezing their type
// would let a long live reply inflate the short-reply average again.
function getTimelineItemType(row: TimelineRow): string {
  if (row.kind !== "message") return row.kind;
  const bucket = Math.max(0, Math.floor(Math.log2(row.message.text.length / 1000)));
  return `message:${row.message.role}:${bucket}`;
}

type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineMessageUserInput = NonNullable<
  Extract<TimelineEntry, { kind: "message" }>["userInput"]
>;
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineCommandExecution = Extract<TimelineEntry, { kind: "command" }>["commandExecution"];

function shouldRenderWorkEntryAsStandaloneRow(
  entry: TimelineWorkEntry,
  options: { settingsExpandMcpToolCalls: boolean },
): boolean {
  return (
    entry.usageLimited === true ||
    entry.activityKind === "user-input.resolved" ||
    !!entry.userInput ||
    !!entry.htmlRender ||
    (entry.itemType === "mcp_tool_call" && options.settingsExpandMcpToolCalls)
  );
}

/** An MCP call drawn as a card (the "expand MCP tool calls" setting), not a log row. */
/** The most calls one MCP card holds. */
export const MCP_CARD_MAX_CALLS = 8;

function isMcpCardWorkEntry(
  entry: TimelineWorkEntry,
  options: { settingsExpandMcpToolCalls: boolean },
): boolean {
  return (
    options.settingsExpandMcpToolCalls &&
    entry.itemType === "mcp_tool_call" &&
    !entry.diagnostic &&
    !entry.mcpApp &&
    !entry.htmlRender
  );
}

function resolveStandaloneExpandedMcpWorkEntry(
  groupedEntries: TimelineWorkEntry[],
  options: { settingsExpandMcpToolCalls: boolean },
): TimelineWorkEntry | null {
  if (!options.settingsExpandMcpToolCalls || groupedEntries.length !== 1) {
    return null;
  }
  const [entry] = groupedEntries;
  return entry?.itemType === "mcp_tool_call" ? entry : null;
}

type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
      /** Above the newest user message, so eligible for collapsing. */
      isPriorTurn: boolean;
      /** Set when the row is one computer or browser-preview run. */
      automationSurface?: AutomationSurface;
      /** The run belongs to the turn that is still working, so its calls may be live. */
      automationActive?: boolean;
      /** Back-to-back MCP calls of one turn, rendered as one MCP card. */
      mcpGroup?: boolean;
      workSummary: string;
      /** Another tool row follows, so this one keeps a tighter bottom gap. */
      compactBottom?: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      /** A message-mode answer renders as its question's Q&A card. */
      userInput?: TimelineMessageUserInput;
      durationStart: string | undefined;
      showCompletionDivider: boolean;
      completionSummary: string | null;
      completionStartedAt?: string;
      completionCompletedAt?: string;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | {
      kind: "command";
      id: string;
      createdAt: string;
      commandExecution: TimelineCommandExecution;
      nestedDiagnostics?: ReadonlyArray<TimelineWorkEntry>;
      /** Another tool row follows, so this one keeps a tighter bottom gap. */
      compactBottom?: boolean;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      activity: string | null;
      /** The latest thought while a later tool runs. */
      thought: string | null;
    };

/** Tool rows followed by another tool row sit closer, so a turn's calls read as one block. */
function isToolTimelineRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "work" || row?.kind === "command";
}

/** Label for the working row: what the running turn is doing right now. */
function workingActivityLabel(
  rows: ReadonlyArray<TimelineRow>,
  liveActivity: LiveWorkActivity,
): string | null {
  if (!liveActivity) return null;
  if (liveActivity.kind === "thinking") {
    return liveActivity.detail ? `Thinking: ${liveActivity.detail}` : "Thinking";
  }
  if (liveActivity.kind === "reconnecting") {
    return liveActivity.attempt ? `Reconnecting (${liveActivity.attempt})` : "Reconnecting";
  }
  if (liveActivity.kind === "idle") {
    // Streaming text is the activity itself; the row stays generic under it.
    const lastRow = rows.at(-1);
    return lastRow?.kind === "message" && lastRow.message.streaming ? null : "Thinking";
  }
  if (liveActivity.providerItemId) {
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const row = rows[rowIndex];
      if (
        row?.kind === "command" &&
        row.commandExecution.providerItemId === liveActivity.providerItemId
      ) {
        return resolveCommandExecutionSummaryText(row.commandExecution);
      }
      if (row?.kind !== "work") continue;
      const entry = row.groupedEntries.findLast(
        (candidate) =>
          candidate.tone === "tool" && candidate.providerItemId === liveActivity.providerItemId,
      );
      if (entry) return toolWorkEntryHeading(entry);
    }
  }
  return liveActivity.title || null;
}

interface WorkGroupRenderState {
  groupLabel: string;
  hasOverflow: boolean;
  hiddenCount: number;
  isExpanded: boolean;
  paginatedEntryCount: number;
  showHeader: boolean;
  visibleEntries: TimelineWorkEntry[];
}

function resolveWorkGroupRenderState(
  groupedEntries: TimelineWorkEntry[],
  revealedEntryCount: number,
): WorkGroupRenderState {
  const paginatedEntries = groupedEntries.filter((entry) => !isFileChangeWorkEntry(entry));
  const hasOverflow = paginatedEntries.length > WORK_LOG_PAGE_SIZE;
  const normalizedRevealCount = Math.max(WORK_LOG_PAGE_SIZE, revealedEntryCount);
  const visiblePaginatedEntries = hasOverflow
    ? paginatedEntries.slice(-Math.min(paginatedEntries.length, normalizedRevealCount))
    : paginatedEntries;
  const visiblePaginatedEntrySet = new Set(visiblePaginatedEntries);
  const visibleEntries = hasOverflow
    ? groupedEntries.filter(
        (entry) => isFileChangeWorkEntry(entry) || visiblePaginatedEntrySet.has(entry),
      )
    : groupedEntries;
  const hiddenCount = paginatedEntries.length - visiblePaginatedEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  return {
    groupLabel: onlyToolEntries ? "Tool calls" : "Work Log",
    hasOverflow,
    hiddenCount,
    isExpanded: hasOverflow && hiddenCount === 0,
    paginatedEntryCount: paginatedEntries.length,
    showHeader: hasOverflow || !onlyToolEntries,
    visibleEntries,
  };
}

// Live clocks are leaves on the shared 1 Hz ticker so a tick re-renders only
// the text that shows elapsed time, never the timeline or its rows.
function LiveMessageMeta(props: {
  durationStart: string | undefined;
  completedAt: string | undefined;
  streaming: boolean;
}) {
  const nowIso = useNowIso(props.streaming);
  const duration = props.durationStart
    ? formatElapsed(props.durationStart, props.streaming ? nowIso : props.completedAt)
    : null;
  return duration ? `${duration} • ` : null;
}

function LiveWorkingLabel(props: { startedAt: string | null }) {
  return formatWorkingLabel(props.startedAt, useNowIso(true));
}

function LiveWorkingRibbon(
  props: Omit<ComponentProps<typeof WorkingRibbon>, "text"> & { startedAt: string | null },
) {
  const { startedAt, ...ribbonProps } = props;
  return <WorkingRibbon {...ribbonProps} text={formatWorkingLabel(startedAt, useNowIso(true))} />;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

/** `text` with each complete thread reference shown as a linked chip. */
function renderWithThreadReferences(text: string): ReactNode {
  const matches = threadReferenceMatches(text);
  if (matches.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) nodes.push(text.slice(cursor, match.start));
    nodes.push(
      <ThreadReferenceChip
        key={`thread-reference:${match.start}`}
        threadId={match.threadId}
        label={match.label}
        link
      />,
    );
    cursor = match.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * A user message with its code spans, fences, bold and thread references rendered. The full
 * source is parsed and clipped to the displayed prefix, so a collapsed bubble
 * always shows the start of the expanded one.
 */
function UserMessageMarkupText(props: {
  text: string;
  markupSource: string;
  testRenderCountProps: { "data-render-count": number } | undefined;
}) {
  const segments = useMemo(() => {
    const parsed = parseUserMessageMarkup(props.markupSource);
    return props.text.length < props.markupSource.length
      ? clipUserMessageSegments(parsed, props.text.length)
      : parsed;
  }, [props.markupSource, props.text.length]);
  if (!hasUserMessageMarkup(segments)) {
    return (
      <pre
        className="whitespace-pre-wrap wrap-break-word chat-plaintext leading-relaxed text-foreground"
        {...(props.testRenderCountProps ?? {})}
      >
        {props.text}
      </pre>
    );
  }
  return (
    <div
      className="whitespace-pre-wrap wrap-break-word chat-plaintext leading-relaxed text-foreground"
      data-user-message-markup=""
      {...(props.testRenderCountProps ?? {})}
    >
      {segments.map((segment) => {
        switch (segment.kind) {
          case "text":
            return <Fragment key={segment.start}>{segment.raw}</Fragment>;
          case "code":
            return (
              <code key={segment.start} className="user-message-inline-code">
                {segment.value}
              </code>
            );
          case "bold":
            return <strong key={segment.start}>{renderWithThreadReferences(segment.value)}</strong>;
          case "thread-reference":
            return (
              <ThreadReferenceChip
                key={segment.start}
                threadId={segment.threadId}
                label={segment.label}
                link
              />
            );
          case "codeblock":
            return (
              <pre key={segment.start} className="user-message-codeblock">
                <code>{segment.value}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}

function isSkillPrefixBoundary(value: string): boolean {
  return value.length === 0 || /\s/u.test(value);
}

function hasRenderableSkillPrefix(
  text: string,
  skillCall: UserMessageSkillCall | undefined,
): boolean {
  return getRenderableSkillPrefix(text, skillCall) !== null;
}

function getRenderableSkillPrefix(
  text: string,
  skillCall: UserMessageSkillCall | undefined,
): string | null {
  if (!skillCall) {
    return null;
  }
  for (const prefix of [`$${skillCall.name}`, `/${skillCall.name}`]) {
    if (text.startsWith(prefix) && isSkillPrefixBoundary(text.charAt(prefix.length))) {
      return prefix;
    }
  }
  return null;
}

function collapsedTextPreservesSkillPrefix(input: {
  text: string;
  collapsedText: string;
  skillCall: UserMessageSkillCall | undefined;
}): boolean {
  if (!hasRenderableSkillPrefix(input.text, input.skillCall)) {
    return true;
  }
  return hasRenderableSkillPrefix(input.collapsedText, input.skillCall);
}

const TimelineUserMessageBody = memo(function TimelineUserMessageBody(props: {
  text: string;
  skillCall?: UserMessageSkillCall | undefined;
  terminalContexts: ParsedTerminalContextEntry[];
  markup: boolean;
  forceExpandedForFind: boolean;
}) {
  const preservesCollapsedPrefix = useCallback(
    (collapsedText: string) =>
      collapsedTextPreservesSkillPrefix({
        text: props.text,
        collapsedText,
        skillCall: props.skillCall,
      }),
    [props.text, props.skillCall],
  );
  const renderBody = useCallback(
    (text: string, collapsed: boolean) => (
      <UserMessageBody
        text={text}
        {...(collapsed ? { markupSource: props.text } : {})}
        skillCall={props.skillCall}
        terminalContexts={collapsed ? [] : props.terminalContexts}
        markup={props.markup}
      />
    ),
    [props.text, props.skillCall, props.terminalContexts, props.markup],
  );
  return (
    <CollapsibleUserMessageBody
      text={props.text}
      collapseAllowed={props.terminalContexts.length === 0}
      preservesCollapsedPrefix={preservesCollapsedPrefix}
      renderBody={renderBody}
      forceExpandedForFind={props.forceExpandedForFind}
    />
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  /** The full message when `text` is its collapsed prefix. */
  markupSource?: string;
  skillCall?: UserMessageSkillCall | undefined;
  terminalContexts: ParsedTerminalContextEntry[];
  markup?: boolean;
}) {
  // Test-only render-attempt counter used by browser regression tests. This
  // intentionally measures render calls, not committed renders.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const testRenderCountProps =
    import.meta.env.MODE === "test" ? { "data-render-count": renderCountRef.current } : undefined;
  const skillPrefix = getRenderableSkillPrefix(props.text, props.skillCall);
  const hasSkillPrefix = skillPrefix !== null;
  const skillNodes: ReactNode[] = [];
  const text =
    hasSkillPrefix && skillPrefix !== null ? props.text.slice(skillPrefix.length) : props.text;
  const skillSeparator = hasSkillPrefix ? text.charAt(0) : "";
  const textAfterSkillPrefix = hasSkillPrefix && skillSeparator.length > 0 ? text.slice(1) : text;
  if (hasSkillPrefix && props.skillCall) {
    skillNodes.push(<SkillInlineChip key="user-message-skill-call" name={props.skillCall.name} />);
    if (skillSeparator.length > 0) {
      skillNodes.push(
        <span key="user-message-skill-call-space" aria-hidden="true">
          {skillSeparator}
        </span>,
      );
    }
  }

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      textAfterSkillPrefix,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [...skillNodes];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = textAfterSkillPrefix.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {renderWithThreadReferences(textAfterSkillPrefix.slice(cursor, matchIndex))}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < textAfterSkillPrefix.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {renderWithThreadReferences(textAfterSkillPrefix.slice(cursor))}
            </span>,
          );
        }

        return (
          <div
            className="wrap-break-word whitespace-pre-wrap chat-plaintext leading-relaxed text-foreground"
            {...(testRenderCountProps ?? {})}
          >
            {inlineNodes}
          </div>
        );
      }
    }

    inlineNodes.length = 0;
    inlineNodes.push(...skillNodes);
    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (textAfterSkillPrefix.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          {renderWithThreadReferences(textAfterSkillPrefix)}
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div
        className="wrap-break-word whitespace-pre-wrap chat-plaintext leading-relaxed text-foreground"
        {...(testRenderCountProps ?? {})}
      >
        {inlineNodes}
      </div>
    );
  }

  if (!hasSkillPrefix && textAfterSkillPrefix.length === 0) {
    return null;
  }

  if (hasSkillPrefix) {
    return (
      <div
        className="wrap-break-word whitespace-pre-wrap chat-plaintext leading-relaxed text-foreground"
        {...(testRenderCountProps ?? {})}
      >
        {skillNodes}
        {textAfterSkillPrefix.length > 0 ? (
          <span key="user-message-skill-call-rest">
            {renderWithThreadReferences(textAfterSkillPrefix)}
          </span>
        ) : null}
      </div>
    );
  }

  if (props.markup) {
    return (
      <UserMessageMarkupText
        text={textAfterSkillPrefix}
        markupSource={props.markupSource ?? textAfterSkillPrefix}
        testRenderCountProps={testRenderCountProps}
      />
    );
  }

  return (
    <pre
      className="whitespace-pre-wrap wrap-break-word chat-plaintext leading-relaxed text-foreground"
      {...(testRenderCountProps ?? {})}
    >
      {renderWithThreadReferences(textAfterSkillPrefix)}
    </pre>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-destructive-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-destructive-foreground";
  if (tone === "tool") return "text-muted-foreground";
  if (tone === "thinking") return "text-muted-foreground";
  return "text-muted-foreground";
}

interface WorkEntryChangedFilePreview {
  rawPath: string;
  targetPath: string;
  displayPath: string;
}

function resolveWorkEntryFilePreview(
  rawPath: string,
  executionCwd: string | undefined,
  workspaceRoot: string | undefined,
): WorkEntryChangedFilePreview {
  const targetPath = executionCwd ? resolvePathLinkTarget(rawPath, executionCwd) : rawPath;
  const { path } = splitPathAndPosition(targetPath);
  return {
    rawPath,
    targetPath,
    displayPath: relativePathForDisplay(path, workspaceRoot),
  };
}

export function changedFilesForPreview(
  workEntry: Pick<TimelineWorkEntry, "cwd" | "turnId" | "changedFiles">,
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
): WorkEntryChangedFilePreview[] | undefined {
  const directChangedFiles = workEntry.changedFiles;
  if (directChangedFiles && directChangedFiles.length > 0) {
    return directChangedFiles.map((filePath) =>
      resolveWorkEntryFilePreview(filePath, workEntry.cwd, workspaceRoot),
    );
  }
  if (!workEntry.turnId) {
    return undefined;
  }
  const turnSummary = turnDiffSummaryByTurnId.get(workEntry.turnId);
  if (!turnSummary || turnSummary.files.length === 0) {
    return undefined;
  }
  return turnSummary.files.map((file) =>
    resolveWorkEntryFilePreview(file.path, undefined, workspaceRoot),
  );
}

function formatChangedFilesPreview(
  changedFiles: ReadonlyArray<WorkEntryChangedFilePreview> | undefined,
) {
  if ((changedFiles?.length ?? 0) === 0) return null;
  const firstFile = changedFiles?.[0];
  if (!firstFile) return null;
  return changedFiles!.length === 1
    ? firstFile.displayPath
    : `${firstFile.displayPath} +${changedFiles!.length - 1} more`;
}

function normalizedReadWorkEntry(
  workEntry: Pick<TimelineWorkEntry, "command" | "lineSummary" | "readPaths">,
): {
  filePaths: ReadonlyArray<string>;
  lineSummary?: string;
} | null {
  if (workEntry.command) {
    const commandClassification = classifyCompactCommand(workEntry.command);
    if (commandClassification.kind === "file-read") {
      return {
        filePaths: commandClassification.fileRead.filePaths,
        ...(commandClassification.fileRead.lineSummary
          ? { lineSummary: commandClassification.fileRead.lineSummary }
          : {}),
      };
    }
  }

  if (!workEntry.readPaths || workEntry.readPaths.length === 0) {
    return null;
  }

  return {
    filePaths: workEntry.readPaths,
    ...(workEntry.lineSummary ? { lineSummary: workEntry.lineSummary } : {}),
  };
}

function workEntryReadFilesForPreview(
  workEntry: Pick<TimelineWorkEntry, "command" | "lineSummary" | "readPaths">,
  executionCwd: string | undefined,
  workspaceRoot: string | undefined,
) {
  const readMatch = normalizedReadWorkEntry(workEntry);
  if (!readMatch) {
    return [];
  }
  return readMatch.filePaths.map((filePath) =>
    resolveWorkEntryFilePreview(filePath, executionCwd, workspaceRoot),
  );
}

function workEntryInlineFilePreview(
  workEntry: Pick<TimelineWorkEntry, "command" | "lineSummary" | "readPaths">,
  executionCwd: string | undefined,
  workspaceRoot: string | undefined,
): InlineFilePreview | null {
  const readMatch = normalizedReadWorkEntry(workEntry);
  if (!readMatch) {
    return null;
  }

  const primaryPath = readMatch.filePaths[0];
  if (!primaryPath) {
    return null;
  }

  const primaryFile = resolveWorkEntryFilePreview(primaryPath, executionCwd, workspaceRoot);
  const extraFilesSummary =
    readMatch.filePaths.length > 1 ? ` +${readMatch.filePaths.length - 1} more` : "";
  const lineSummary = readMatch.lineSummary ? ` (${readMatch.lineSummary})` : "";
  const trailingText = `${extraFilesSummary}${lineSummary}`;
  return {
    targetPath: primaryFile.targetPath,
    label: primaryFile.displayPath,
    text: `${primaryFile.displayPath}${trailingText}`,
    trailingText,
  };
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const rawValue = record[key];
    if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue > 0) {
      return rawValue;
    }
    if (typeof rawValue === "string" && /^\d+$/.test(rawValue)) {
      const parsed = Number.parseInt(rawValue, 10);
      if (parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parsePositiveIntegerString(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

function formatInlineFileReadPosition(input: {
  line: number | undefined;
  endLine: number | undefined;
  column: number | undefined;
}): string | null {
  if (!input.line) {
    return null;
  }
  if (input.column) {
    return `line ${input.line}:${input.column}`;
  }
  if (input.endLine && input.endLine > input.line) {
    return `lines ${input.line}-${input.endLine}`;
  }
  return `line ${input.line}`;
}

interface InlineFilePreview {
  targetPath: string;
  label: string;
  text: string;
  trailingText: string;
}

interface ParsedFileReadDetail {
  source: "structured" | "bare-path";
  rawPath: string;
  line: number | undefined;
  endLine: number | undefined;
  column: number | undefined;
}

function inferredFileOperationHeading(
  workEntry: Pick<
    TimelineWorkEntry,
    "detail" | "itemType" | "label" | "readPaths" | "requestKind" | "toolTitle"
  >,
): string | null {
  if (isFileReadWorkEntry(workEntry)) {
    return "File read";
  }
  if (isFileChangeWorkEntry(workEntry)) {
    return "File change";
  }
  if (
    workEntry.itemType !== "dynamic_tool_call" &&
    workEntry.itemType !== "mcp_tool_call" &&
    workEntry.itemType !== "file_change"
  ) {
    return null;
  }
  const detail = workEntry.detail?.trim();
  if (!detail) {
    return null;
  }
  if (/^read(?:\s+file)?\b/i.test(detail)) {
    return "File read";
  }
  if (/^(?:write|create|update|edit)(?:\s+file)?\b/i.test(detail)) {
    return "Write file";
  }
  return null;
}

function parseFileReadDetail(detail: string): ParsedFileReadDetail | null {
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const jsonCandidates = new Set<string>([trimmed]);
  const firstBraceIndex = trimmed.indexOf("{");
  const lastBraceIndex = trimmed.lastIndexOf("}");
  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    jsonCandidates.add(trimmed.slice(firstBraceIndex, lastBraceIndex + 1));
  }

  for (const candidate of jsonCandidates) {
    let parsedDetail: unknown;
    try {
      parsedDetail = JSON.parse(candidate);
    } catch {
      continue;
    }

    const record = asUnknownRecord(parsedDetail);
    if (!record) {
      continue;
    }

    const rawPath = [
      record.file_path,
      record.filePath,
      record.relative_path,
      record.relativePath,
      record.path,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (!rawPath) {
      continue;
    }

    return {
      source: "structured",
      rawPath,
      line: readPositiveInteger(record, ["line", "lineNumber", "line_number", "start_line"]),
      endLine: readPositiveInteger(record, ["endLine", "end_line"]),
      column: readPositiveInteger(record, ["column", "columnNumber", "column_number"]),
    };
  }

  const pathMatches = extractTerminalLinks(trimmed).filter((match) => match.kind === "path");
  const pathMatch = pathMatches[0];
  if (!pathMatch || pathMatches.length !== 1) {
    return null;
  }
  if (pathMatch.start !== 0 || pathMatch.end !== trimmed.length) {
    return null;
  }

  const { path, line, column } = splitPathAndPosition(pathMatch.text);
  if (path.trim().length === 0) {
    return null;
  }

  return {
    source: "bare-path",
    rawPath: path,
    line: parsePositiveIntegerString(line),
    endLine: undefined,
    column: parsePositiveIntegerString(column),
  };
}

function resolveInlineFilePreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "changedFiles"
    | "command"
    | "cwd"
    | "detail"
    | "itemType"
    | "label"
    | "lineSummary"
    | "readPaths"
    | "requestKind"
    | "toolTitle"
    | "turnId"
  >,
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
): InlineFilePreview | null {
  const normalizedReadPreview = workEntryInlineFilePreview(workEntry, workEntry.cwd, workspaceRoot);
  if (normalizedReadPreview) {
    return normalizedReadPreview;
  }

  const changedFiles = changedFilesForPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot);
  const fileReadEntry = isFileReadWorkEntry(workEntry);
  const fileChangeEntry = isFileChangeWorkEntry(workEntry);
  if (
    !workEntry.command &&
    changedFiles &&
    changedFiles.length > 0 &&
    (fileReadEntry || fileChangeEntry)
  ) {
    const primaryFile = changedFiles[0];
    if (!primaryFile) {
      return null;
    }
    const suffix = fileReadEntry
      ? `${changedFiles.length > 1 ? ` +${changedFiles.length - 1} more` : ""}${
          workEntry.detail ? ` (${workEntry.detail})` : ""
        }`
      : changedFiles.length > 1
        ? ` +${changedFiles.length - 1} more`
        : "";
    return {
      targetPath: primaryFile.targetPath,
      label: primaryFile.displayPath,
      text: `${primaryFile.displayPath}${suffix}`,
      trailingText: suffix,
    };
  }

  if (!workEntry.detail) {
    return null;
  }

  const parsedDetail = parseFileReadDetail(workEntry.detail);
  if (!parsedDetail) {
    return null;
  }

  const allowsStructuredDetailPreview =
    fileReadEntry ||
    fileChangeEntry ||
    workEntry.itemType === "dynamic_tool_call" ||
    workEntry.itemType === "mcp_tool_call";
  const allowsBarePathDetailPreview = fileReadEntry || fileChangeEntry;
  if (
    (parsedDetail.source === "structured" && !allowsStructuredDetailPreview) ||
    (parsedDetail.source === "bare-path" && !allowsBarePathDetailPreview)
  ) {
    return null;
  }

  const positionSummary = formatInlineFileReadPosition({
    line: parsedDetail.line,
    endLine: parsedDetail.endLine,
    column: parsedDetail.column,
  });
  const rawTargetPath = parsedDetail.line
    ? `${parsedDetail.rawPath}:${parsedDetail.line}${parsedDetail.column ? `:${parsedDetail.column}` : ""}`
    : parsedDetail.rawPath;
  const resolvedFile = resolveWorkEntryFilePreview(rawTargetPath, workEntry.cwd, workspaceRoot);
  const trailingText = positionSummary ? ` (${positionSummary})` : "";
  return {
    targetPath: resolvedFile.targetPath,
    label: resolvedFile.displayPath,
    text: `${resolvedFile.displayPath}${trailingText}`,
    trailingText,
  };
}

function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "detail"
    | "command"
    | "cwd"
    | "changedFiles"
    | "itemType"
    | "label"
    | "lineSummary"
    | "readPaths"
    | "requestKind"
    | "searchSummary"
    | "toolTitle"
    | "turnId"
  >,
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
) {
  const searchSummary = normalizedSearchSummary(workEntry);
  if (searchSummary) {
    return undefined;
  }
  if (workEntry.command) {
    return workEntry.command;
  }
  if (workEntry.itemType === "mcp_tool_call") return undefined;

  const changedFilesPreview = formatChangedFilesPreview(
    changedFilesForPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot),
  );
  const isFileChangeRow =
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change" ||
    changedFilesPreview !== null;

  if (workEntry.requestKind === "file-read" && changedFilesPreview) {
    return workEntry.detail ? `${changedFilesPreview} (${workEntry.detail})` : changedFilesPreview;
  }

  if (isFileChangeRow && changedFilesPreview) {
    return changedFilesPreview;
  }
  const dynamicTool = describeDynamicToolEntry(workEntry);
  if (dynamicTool) return dynamicTool.preview ?? undefined;
  if (workEntry.detail) return workEntry.detail;
  return changedFilesPreview;
}

type TimelineEntryIcon = Icon | LucideIcon;

const DYNAMIC_TOOL_ICONS: Record<DynamicToolIconKind, LucideIcon> = {
  search: SearchIcon,
  web: GlobeIcon,
  tasks: ListTodoIcon,
  tool: HammerIcon,
};

function workEntryIcon(workEntry: TimelineWorkEntry): TimelineEntryIcon {
  if (workEntry.requestKind === "command") {
    const commandClassification = workEntry.command
      ? classifyCompactCommand(workEntry.command)
      : { kind: "other" as const };
    if (commandClassification.kind === "file-read") {
      return EyeIcon;
    }
    if (commandClassification.kind === "search" || isSearchWorkEntry(workEntry)) {
      return SearchIcon;
    }
    return TerminalIcon;
  }
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    const commandClassification = workEntry.command
      ? classifyCompactCommand(workEntry.command)
      : { kind: "other" as const };
    if (commandClassification.kind === "file-read") {
      return EyeIcon;
    }
    if (commandClassification.kind === "search" || isSearchWorkEntry(workEntry)) {
      return SearchIcon;
    }
    return TerminalIcon;
  }
  if (isSearchWorkEntry(workEntry)) return SearchIcon;
  if (isFileReadWorkEntry(workEntry)) return EyeIcon;
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (workEntry.itemType === "image_generation") return ImageIcon;
  if (workEntry.itemType === "sleep") return ClockIcon;
  const dynamicTool = describeDynamicToolEntry(workEntry);
  if (dynamicTool) return DYNAMIC_TOOL_ICONS[dynamicTool.icon];

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return iconForItemType(workEntry.itemType);
    case "dynamic_tool_call":
      return iconForItemType(workEntry.itemType);
    case "collab_agent_tool_call":
      return iconForItemType(workEntry.itemType);
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function formatMcpIdentifier(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  if (normalized.length === 0) {
    return value;
  }
  return normalized
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function formatMcpToolHeading(workEntry: TimelineWorkEntry): string {
  if (workEntry.mcpServerName && workEntry.mcpToolName) {
    return `${formatMcpIdentifier(workEntry.mcpServerName)}: ${formatMcpIdentifier(
      workEntry.mcpToolName,
    )}`;
  }
  if (workEntry.mcpToolName) {
    return formatMcpIdentifier(workEntry.mcpToolName);
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function isGenericInferredActivityHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "tool call" || normalized === "reasoning update";
}

export function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  const computer = workEntry.computerTool
    ? computerToolHeading(workEntry.mcpToolName, workEntry.status)
    : undefined;
  if (computer) return `Computer · ${computer}`;
  const preview =
    classifyAutomationEntry(workEntry) === "preview"
      ? previewToolHeading(workEntry.mcpToolName, workEntry.status)
      : undefined;
  if (preview) return `Browser · ${preview}`;
  if (workEntry.itemType === "mcp_tool_call") {
    return `MCP Call - ${formatMcpToolHeading(workEntry)}`;
  }
  const searchSummary = normalizedSearchSummary(workEntry);
  if (searchSummary) {
    return searchSummary;
  }
  const normalizedHeading = normalizedWorkEntryHeading(workEntry);
  if (normalizedHeading.length === 0) {
    return capitalizePhrase(workEntry.label);
  }
  if (workEntry.command && isGenericCommandTitle(normalizedHeading)) {
    const commandClassification = classifyCompactCommand(workEntry.command);
    if (commandClassification.kind === "file-read") {
      return "File read";
    }
    if (commandClassification.kind === "search") {
      return commandClassification.summary;
    }
  }
  if (isGenericInferredActivityHeading(normalizedHeading)) {
    const inferredHeading = inferredFileOperationHeading(workEntry);
    if (inferredHeading) {
      return inferredHeading;
    }
    const dynamicTool = describeDynamicToolEntry(workEntry);
    if (dynamicTool) {
      return dynamicTool.heading;
    }
  }
  return capitalizePhrase(normalizedHeading);
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  showFileChangeDiffsInline: boolean;
  chatDiffContext: ChatDiffContext;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const {
    workEntry,
    turnDiffSummaryByTurnId,
    workspaceRoot,
    resolvedTheme,
    showFileChangeDiffsInline,
    chatDiffContext,
    onOpenTurnDiff,
  } = props;
  const [imageExpanded, setImageExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot);
  const handleFileNavigation = useFileNavigation();
  const fileChangeEntry = isFileChangeWorkEntry(workEntry);
  const inlineFilePreview = useMemo(
    () => resolveInlineFilePreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot),
    [turnDiffSummaryByTurnId, workEntry, workspaceRoot],
  );
  const commandReadFiles = useMemo(
    () => workEntryReadFilesForPreview(workEntry, workEntry.cwd, workspaceRoot),
    [workEntry, workspaceRoot],
  );
  const fileChangePreviews = useMemo(() => {
    if (!fileChangeEntry) {
      return [];
    }
    return (changedFilesForPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot) ?? []).filter(
      (file) => file.targetPath.length > 0,
    );
  }, [fileChangeEntry, turnDiffSummaryByTurnId, workEntry, workspaceRoot]);
  const fileChangeFiles = useMemo(() => {
    if (!fileChangeEntry) {
      return [];
    }
    return fileChangePreviews
      .map((file) => file.targetPath)
      .filter((filePath): filePath is string => filePath.length > 0);
  }, [fileChangeEntry, fileChangePreviews]);
  const displayText = inlineFilePreview
    ? `${heading} - ${inlineFilePreview.text}`
    : preview
      ? `${heading} - ${preview}`
      : heading;
  // A humanized tool row still offers the raw call on hover.
  const dynamicTool = describeDynamicToolEntry(workEntry);
  const hoverText =
    dynamicTool && !inlineFilePreview && heading === dynamicTool.heading && workEntry.detail
      ? `${heading} - ${workEntry.detail}`
      : displayText;
  const hasChangedFiles = fileChangeEntry
    ? fileChangePreviews.length > 0
    : (workEntry.changedFiles?.length ?? 0) > 0;
  const fileChangeTurnSummary = workEntry.turnId
    ? turnDiffSummaryByTurnId.get(workEntry.turnId)
    : undefined;
  const fileChangeCheckpointTurnCount = workEntry.turnId
    ? (fileChangeTurnSummary?.checkpointTurnCount ??
      chatDiffContext.inferredCheckpointTurnCountByTurnId[workEntry.turnId])
    : undefined;
  const exactFileChangeSummary = workEntry.fileChangeId
    ? chatDiffContext.fileChangeSummariesById[workEntry.fileChangeId]
    : undefined;
  const canRenderExactInlineFileDiff =
    showFileChangeDiffsInline &&
    workEntry.status === "completed" &&
    exactFileChangeSummary?.status === "completed" &&
    exactFileChangeSummary.hasPatch === true;
  const canRenderTurnFallbackInlineDiff =
    showFileChangeDiffsInline &&
    chatDiffContext.isGitRepo &&
    workEntry.status === "completed" &&
    Boolean(workEntry.turnId) &&
    typeof fileChangeCheckpointTurnCount === "number" &&
    fileChangeFiles.length > 0;
  const canRenderInlineDiff = canRenderExactInlineFileDiff || canRenderTurnFallbackInlineDiff;
  const inlineDiffExpanded = isInlineFileChangeDiffExpanded(
    workEntry.id,
    chatDiffContext.expandedFileChangeDiffs,
  );
  const inlineDiffFileCount =
    exactFileChangeSummary?.changedFiles.length ??
    fileChangeFiles.length ??
    workEntry.changedFiles?.length ??
    0;
  const previewIsChangedFiles =
    hasChangedFiles &&
    !workEntry.command &&
    (isFileReadWorkEntry(workEntry) || isFileChangeWorkEntry(workEntry) || !workEntry.detail);
  const openFileChip = useCallback(
    (filePath: string) => {
      if (handleFileNavigation(filePath, workEntry.turnId ?? undefined)) {
        return;
      }
      const targetPath = workspaceRoot ? resolvePathLinkTarget(filePath, workspaceRoot) : filePath;
      void openFileInEditor(targetPath);
    },
    [handleFileNavigation, workEntry.turnId, workspaceRoot],
  );

  return (
    <div className="rounded-lg px-1 py-0.5">
      <div className="flex min-h-6 items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-ui leading-6",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground" : "",
            )}
            title={hoverText}
          >
            {workEntry.itemType === "image_view" && workEntry.imagePath ? (
              <button
                type="button"
                aria-expanded={imageExpanded}
                onClick={() => setImageExpanded(!imageExpanded)}
              >
                {heading}
              </button>
            ) : canRenderInlineDiff ? (
              <button
                type="button"
                aria-expanded={inlineDiffExpanded}
                className={cn("text-left text-foreground", workToneClass(workEntry.tone))}
                onClick={() => {
                  if (!window.getSelection()?.isCollapsed) return;
                  chatDiffContext.onToggleFileChangeDiff(workEntry.id);
                }}
              >
                {heading}
              </button>
            ) : (
              <span className={cn("text-foreground", workToneClass(workEntry.tone))}>
                {heading}
              </span>
            )}
            {(workEntry.warningCount ?? 1) > 1 ? (
              <span className="ml-1 rounded-sm bg-secondary px-1 py-0.5 text-2xs tabular-nums text-muted-foreground">
                ×{workEntry.warningCount}
              </span>
            ) : null}
            {inlineFilePreview ? (
              <>
                <span className="text-muted-foreground"> {" - "}</span>
                <button
                  type="button"
                  className="max-w-full cursor-pointer truncate text-left text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  onClick={() => openFileChip(inlineFilePreview.targetPath)}
                  title={inlineFilePreview.label}
                >
                  {inlineFilePreview.label}
                </button>
                {inlineFilePreview.trailingText ? (
                  <span className="text-muted-foreground">{inlineFilePreview.trailingText}</span>
                ) : null}
              </>
            ) : preview ? (
              <span className="text-muted-foreground"> - {preview}</span>
            ) : null}
          </p>
          {imageExpanded && workEntry.imagePath && (
            <div className="mt-1 max-w-48">
              <ChatAssetImage src={workEntry.imagePath} alt="Viewed image" cwd={workspaceRoot} />
            </div>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-7">
          {(fileChangeEntry
            ? fileChangePreviews.slice(0, 4)
            : (workEntry.changedFiles?.slice(0, 4) ?? [])
          ).map((file) => {
            const filePath = typeof file === "string" ? file : file.targetPath;
            const fileLabel = typeof file === "string" ? file : file.displayPath;
            return (
              <FileChip
                key={`${workEntry.id}:${filePath}`}
                path={filePath}
                label={fileLabel}
                title={filePath}
                theme={resolvedTheme}
                size="sm"
                onClick={() => openFileChip(filePath)}
              />
            );
          })}
          {(fileChangeEntry ? fileChangePreviews.length : (workEntry.changedFiles?.length ?? 0)) >
            4 && (
            <span className="px-1 text-2xs text-muted-foreground">
              +
              {(fileChangeEntry
                ? fileChangePreviews.length
                : (workEntry.changedFiles?.length ?? 0)) - 4}
            </span>
          )}
        </div>
      )}
      {!hasChangedFiles && !inlineFilePreview && commandReadFiles.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 pl-7">
          {commandReadFiles.slice(0, 4).map((file) => (
            <FileChip
              key={`${workEntry.id}:${file.rawPath}`}
              path={file.targetPath}
              label={file.displayPath}
              title={file.rawPath}
              theme={resolvedTheme}
              size="sm"
              onClick={() => openFileChip(file.targetPath)}
            />
          ))}
          {commandReadFiles.length > 4 && (
            <span className="px-1 text-2xs text-muted-foreground">
              +{commandReadFiles.length - 4}
            </span>
          )}
        </div>
      )}
      {canRenderInlineDiff ? (
        <div className="mt-1 flex items-center justify-between gap-2 pl-7 pr-1">
          <span className="text-2xs text-muted-foreground">
            {formatInlineDiffFileCountLabel(inlineDiffFileCount)}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 px-2 text-2xs text-muted-foreground hover:text-foreground"
            onMouseEnter={() => void preloadInlineDiffComponents()}
            onFocus={() => void preloadInlineDiffComponents()}
            onClick={() => chatDiffContext.onToggleFileChangeDiff(workEntry.id)}
          >
            {inlineDiffExpanded ? "Hide diff" : "Show diff"}
          </Button>
        </div>
      ) : null}
      {inlineDiffExpanded && canRenderExactInlineFileDiff && workEntry.fileChangeId ? (
        <div className="mt-1 pl-6">
          <DiffSurfaceBoundary
            fallback={<div className="py-3 text-xs text-muted-foreground">Loading diff…</div>}
          >
            <InlineExactFileChangeDiff
              workEntryId={workEntry.id}
              threadId={chatDiffContext.threadId}
              fileChangeId={workEntry.fileChangeId}
              workspaceRoot={workspaceRoot}
              resolvedTheme={resolvedTheme}
              onOpenFileChangeDiff={chatDiffContext.onOpenFileChangeDiff}
              fallback={
                canRenderTurnFallbackInlineDiff && workEntry.turnId ? (
                  <InlineFileChangeDiff
                    workEntryId={workEntry.id}
                    threadId={chatDiffContext.threadId}
                    turnId={workEntry.turnId}
                    checkpointTurnCount={fileChangeCheckpointTurnCount}
                    filePaths={fileChangeFiles}
                    workspaceRoot={workspaceRoot}
                    resolvedTheme={resolvedTheme}
                    turnDiffSummary={fileChangeTurnSummary}
                    onOpenTurnDiff={onOpenTurnDiff}
                  />
                ) : null
              }
            />
          </DiffSurfaceBoundary>
        </div>
      ) : inlineDiffExpanded && canRenderTurnFallbackInlineDiff && workEntry.turnId ? (
        <div className="mt-1 pl-6">
          <DiffSurfaceBoundary
            fallback={<div className="py-3 text-xs text-muted-foreground">Loading diff…</div>}
          >
            <InlineFileChangeDiff
              workEntryId={workEntry.id}
              threadId={chatDiffContext.threadId}
              turnId={workEntry.turnId}
              checkpointTurnCount={fileChangeCheckpointTurnCount}
              filePaths={fileChangeFiles}
              workspaceRoot={workspaceRoot}
              resolvedTheme={resolvedTheme}
              turnDiffSummary={fileChangeTurnSummary}
              onOpenTurnDiff={onOpenTurnDiff}
            />
          </DiffSurfaceBoundary>
        </div>
      ) : null}
    </div>
  );
});

// The theme's one six-hue palette; status colors would read as call outcomes.
const MCP_SERVER_TINT_CLASS_NAMES: Record<number, string> = {
  1: "border-effort-low/45 bg-effort-low/20",
  2: "border-effort-medium/45 bg-effort-medium/20",
  3: "border-effort-high/45 bg-effort-high/20",
  4: "border-effort-xhigh/45 bg-effort-xhigh/20",
  5: "border-effort-max/45 bg-effort-max/20",
  6: "border-effort-deepest/45 bg-effort-deepest/20",
};

function McpServerIcon(props: { serverName: string; label: string }) {
  const kind = mcpServerIconKind(props.serverName, props.label);
  const tileClassName =
    "flex size-5.5 shrink-0 items-center justify-center rounded-md border text-foreground";
  if (kind === "monogram") {
    return (
      <span
        aria-hidden="true"
        data-mcp-server-icon="monogram"
        className={cn(
          tileClassName,
          "text-2xs font-semibold",
          MCP_SERVER_TINT_CLASS_NAMES[mcpServerTint(props.serverName)],
        )}
      >
        {mcpServerMonogram(props.label)}
      </span>
    );
  }
  const glyphClassName = "size-3.5";
  return (
    <span
      aria-hidden="true"
      data-mcp-server-icon={kind}
      className={cn(tileClassName, "border-border/70 bg-background/60")}
    >
      {kind === "github" ? (
        <GitHubIcon className={glyphClassName} />
      ) : kind === "linear" ? (
        <LinearIcon className={glyphClassName} />
      ) : kind === "notion" ? (
        <NotionIcon className={glyphClassName} />
      ) : kind === "slack" ? (
        <SlackIcon className={glyphClassName} />
      ) : kind === "figma" ? (
        <FigmaIcon className={glyphClassName} />
      ) : kind === "claude" ? (
        <ClaudeAI className={glyphClassName} />
      ) : (
        <img src="/favicon-32x32.png" alt="" className={cn(glyphClassName, "rounded-xs")} />
      )}
    </span>
  );
}

const MCP_CALL_STATUS_PRESENTATION: Record<
  McpCallDisplayStatus,
  { label: string; Icon: LucideIcon; iconClassName: string; accentClassName: string }
> = {
  running: {
    label: "Running",
    Icon: LoaderCircleIcon,
    iconClassName: "animate-spin text-info motion-reduce:animate-none",
    accentClassName: "border-l-info/70",
  },
  completed: {
    label: "Completed",
    Icon: CheckIcon,
    iconClassName: "text-success",
    accentClassName: "border-l-success/70",
  },
  failed: {
    label: "Failed",
    Icon: XIcon,
    iconClassName: "text-destructive",
    accentClassName: "border-l-destructive/80",
  },
  interrupted: {
    label: "Interrupted",
    Icon: CircleStopIcon,
    iconClassName: "text-warning",
    accentClassName: "border-l-warning/70",
  },
  declined: {
    label: "Declined",
    Icon: BanIcon,
    iconClassName: "text-muted-foreground",
    accentClassName: "border-l-border",
  },
};

function mcpCallDisplayStatus(
  entry: TimelineWorkEntry,
  threadWorking: boolean,
): McpCallDisplayStatus {
  // Matches automation step drawers: a declined call isn't a failure.
  if (isAutomationEntryFailed(entry)) return "failed";
  if (entry.status === "declined") return "declined";
  // On an idle thread a running call is a completion that never arrived.
  if (entry.status === "inProgress") return threadWorking ? "running" : "interrupted";
  return "completed";
}

function mcpCallFinishedAt(entry: TimelineWorkEntry): string {
  return entry.completedAt ?? entry.createdAt;
}

/** From the first call's start to the last call's finish. */
function mcpCallGroupSpan(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  const starts = entries.map((entry) => Date.parse(entry.startedAt ?? entry.createdAt));
  const ends = entries.map((entry) => Date.parse(mcpCallFinishedAt(entry)));
  const spanMs = Math.max(...ends) - Math.min(...starts);
  return Number.isFinite(spanMs) && spanMs > 0 ? formatDuration(spanMs) : null;
}

/**
 * Back-to-back MCP calls of a turn share one card: an "MCP" header, then a row per call
 * that expands on its own. The accent follows the most telling status in the card.
 */
const McpToolCallGroupCard = memo(function McpToolCallGroupCard(props: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  expandByDefault: boolean;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { isWorking } = useTimelineRowContext();
  const aggregate = mcpAggregateStatus(
    props.entries.map((entry) => mcpCallDisplayStatus(entry, isWorking)),
  );
  const callCount = props.entries.length;
  const span = callCount > 1 && aggregate !== "running" ? mcpCallGroupSpan(props.entries) : null;
  return (
    <div
      className={cn(
        "group rounded-xl border border-l-2 border-border/60 bg-card/35",
        MCP_CALL_STATUS_PRESENTATION[aggregate].accentClassName,
      )}
      data-slot="mcp-tool-card"
      data-mcp-call-count={callCount}
    >
      <div
        className="flex min-h-6 items-center gap-1.5 border-b border-border/60 px-3 py-1 text-2xs text-muted-foreground"
        data-testid="mcp-card-header"
      >
        <McpIcon aria-hidden="true" className="size-3" />
        <span className="font-semibold tracking-wide">MCP</span>
        {callCount > 1 ? (
          <span className="ml-auto tabular-nums" data-testid="mcp-card-call-count">
            {callCount} calls{span ? ` · ${span}` : ""}
          </span>
        ) : null}
      </div>
      <div className="divide-y divide-border/60">
        {props.entries.map((entry) => (
          <McpToolCallRow
            key={entry.id}
            workEntry={entry}
            expandByDefault={props.expandByDefault}
            markdownCwd={props.markdownCwd}
            timestampFormat={props.timestampFormat}
            threadWorking={isWorking}
            onImageExpand={props.onImageExpand}
          />
        ))}
      </div>
    </div>
  );
});

const McpToolCallRow = memo(function McpToolCallRow(props: {
  workEntry: TimelineWorkEntry;
  expandByDefault: boolean;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
  /** A running call on an idle thread (a lost completion) stops counting. */
  threadWorking: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { workEntry, markdownCwd, expandByDefault, onImageExpand } = props;
  const hasNestedContent = Boolean(workEntry.mcpInput) || Boolean(workEntry.mcpResult);
  const defaultOpen = hasNestedContent && expandByDefault;
  const [open, setOpen] = useState(defaultOpen);
  const [userOverrodeOpen, setUserOverrodeOpen] = useState(false);

  useEffect(() => {
    if (userOverrodeOpen) {
      return;
    }
    setOpen(defaultOpen);
  }, [defaultOpen, userOverrodeOpen]);

  // The tooltip keeps the fuller "MCP Call - <server>: <tool>" phrasing.
  const hoverTitle = toolWorkEntryHeading(workEntry);
  const serverName = workEntry.mcpServerName;
  const serverLabel = workEntry.mcpServerLabel ?? serverName;
  const toolName = workEntry.mcpToolName ?? formatMcpToolHeading(workEntry);
  const status = mcpCallDisplayStatus(workEntry, props.threadWorking);
  const failed = status === "failed";
  const running = status === "running";
  const statusPresentation = MCP_CALL_STATUS_PRESENTATION[status];
  // Only a running call subscribes to the shared clock.
  const nowIso = useNowIso(running);
  const startedAt = workEntry.startedAt ?? workEntry.createdAt;
  const finishedMs =
    workEntry.startedAt && status !== "interrupted"
      ? Date.parse(mcpCallFinishedAt(workEntry)) - Date.parse(workEntry.startedAt)
      : Number.NaN;
  const duration = running
    ? formatElapsed(startedAt, nowIso)
    : finishedMs > 0
      ? formatDuration(finishedMs)
      : null;
  const inputSummary = useMemo(() => {
    const input = parseJsonObject(workEntry.mcpInput);
    return input ? summarizeToolInputPairs(input, { quoteStrings: true }) : null;
  }, [workEntry.mcpInput]);
  const resultPreview = useMemo(
    () =>
      running
        ? null
        : summarizeMcpResult(workEntry.mcpResult, parseJsonObject, (input) =>
            summarizeToolInputPairs(input, { quoteStrings: true }),
          ),
    [running, workEntry.mcpResult],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setUserOverrodeOpen(true);
    setOpen(nextOpen);
  }, []);

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      data-slot="mcp-tool-call"
      data-status={status}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          !hasNestedContent && "cursor-default",
        )}
        disabled={!hasNestedContent}
        title={hoverTitle}
      >
        <statusPresentation.Icon
          role="img"
          aria-label={statusPresentation.label}
          className={cn("size-3.5 shrink-0", statusPresentation.iconClassName)}
        />
        <McpServerIcon serverName={serverName ?? toolName} label={serverLabel ?? toolName} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui">
          {serverLabel ? (
            <span className="shrink-0 text-muted-foreground">{serverLabel} ›</span>
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground">{toolName}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground tabular-nums">
          {duration ? (
            <span
              title={`Started ${formatTimestamp(startedAt, props.timestampFormat)} · since the call started, including input streaming and any approval wait`}
            >
              {duration}
            </span>
          ) : (
            // Without a start time there's no duration to carry the time in its tooltip.
            <span data-testid="mcp-call-time">
              {formatTimestamp(workEntry.createdAt, props.timestampFormat)}
            </span>
          )}
          {hasNestedContent ? (
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 text-faint-foreground transition-transform duration-(--duration-fast)",
                !open && "-rotate-90",
              )}
            />
          ) : null}
        </span>
      </CollapsibleTrigger>
      {!open && inputSummary ? (
        <p
          className="-mt-1 truncate px-3 pb-2 pl-17 text-xs text-muted-foreground"
          data-testid="mcp-input-summary"
        >
          {inputSummary}
        </p>
      ) : null}
      {!open && resultPreview ? (
        <p
          className={cn(
            "-mt-1 truncate px-3 pb-2 pl-17 font-mono text-xs",
            failed ? "text-destructive-foreground" : "text-muted-foreground",
          )}
          data-testid="mcp-result-preview"
        >
          {failed ? resultPreview : `→ ${resultPreview}`}
        </p>
      ) : null}
      {workEntry.nestedDiagnostics && workEntry.nestedDiagnostics.length > 0 ? (
        <NestedDiagnosticList
          diagnostics={workEntry.nestedDiagnostics}
          className="mr-3 mb-2 ml-17"
        />
      ) : null}
      {workEntry.mcpImages && workEntry.mcpImages.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pb-2.5 pl-17" data-testid="mcp-tool-images">
          {workEntry.mcpImages.map((image) => {
            const url = attachmentPreviewUrlForId(image.attachmentId);
            return (
              // Attachment URLs need the app's session, so open them in the in-app viewer;
              // a plain link handed them to the system browser, which got a 401.
              <button
                key={image.attachmentId}
                type="button"
                className="cursor-zoom-in rounded-md"
                aria-label="Preview tool result screenshot"
                onClick={() => {
                  const preview = buildExpandedImagePreview(
                    (workEntry.mcpImages ?? []).map((candidate, candidateIndex) => ({
                      id: candidate.attachmentId,
                      name: `Screenshot ${candidateIndex + 1}`,
                      mimeType: candidate.mimeType,
                      previewUrl: attachmentPreviewUrlForId(candidate.attachmentId),
                    })),
                    image.attachmentId,
                  );
                  if (preview) onImageExpand(preview);
                }}
              >
                <img
                  src={url}
                  alt="Tool result screenshot"
                  loading="lazy"
                  className="h-24 max-w-64 rounded-md border border-border object-cover object-top"
                />
              </button>
            );
          })}
          {workEntry.mcpImagesOmitted ? (
            <span className="self-end text-2xs text-muted-foreground">
              +{workEntry.mcpImagesOmitted} not shown
            </span>
          ) : null}
        </div>
      ) : null}
      {hasNestedContent && (
        <CollapsiblePanel>
          <div className="border-t border-border/60 px-3 py-3 pl-17">
            <McpToolCallDetails
              mcpInput={workEntry.mcpInput}
              mcpResult={workEntry.mcpResult}
              markdownCwd={markdownCwd}
              failed={failed}
            />
          </div>
        </CollapsiblePanel>
      )}
    </Collapsible>
  );
});

const SubagentWorkEntryRow = memo(function SubagentWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
}) {
  const { workEntry, turnDiffSummaryByTurnId, workspaceRoot, markdownCwd } = props;
  const isCodexCollaboration = Boolean(workEntry.codexCollaborationTool);
  const responseRows = isCodexCollaboration
    ? deriveCodexCollaborationResponseRows(
        workEntry.subagentReceiverThreadIds ?? [],
        workEntry.subagentStates ?? [],
      )
    : [];
  const isCompletedEmptyWait =
    workEntry.codexCollaborationTool === "wait" &&
    workEntry.status === "completed" &&
    responseRows.length === 0;
  const hasResponseDetails =
    responseRows.length > 0 || Boolean(workEntry.subagentStatesTruncated) || isCompletedEmptyWait;
  const hasCorrelatedAgentPath = Boolean(
    workEntry.subagentPath &&
    workEntry.subagentThreadId &&
    workEntry.subagentReceiverThreadIds?.includes(workEntry.subagentThreadId),
  );
  const [open, setOpen] = useState(Boolean(workEntry.subagentResult) || hasResponseDetails);
  const [userOverrodeOpen, setUserOverrodeOpen] = useState(false);

  useEffect(() => {
    if (userOverrodeOpen) {
      return;
    }
    setOpen(Boolean(workEntry.subagentResult) || hasResponseDetails);
  }, [hasResponseDetails, userOverrodeOpen, workEntry.subagentResult]);

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = workEntry.codexCollaborationTool
    ? resolveCodexCollaborationHeading(
        workEntry.codexCollaborationTool,
        workEntry.status,
        workEntry.subagentReceiverThreadIds?.length ?? 0,
      )
    : toolWorkEntryHeading(workEntry);
  const preview =
    (isCodexCollaboration
      ? (workEntry.subagentPrompt ?? workEntry.subagentDescription ?? workEntry.subagentPath)
      : workEntry.subagentDescription) ??
    workEntry.detail ??
    (!isCodexCollaboration ? workEntry.subagentPath : undefined) ??
    workEntry.subagentResult ??
    workEntryPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasNestedContent = isCodexCollaboration
    ? hasResponseDetails || hasCorrelatedAgentPath
    : Boolean(workEntry.subagentPrompt) ||
      Boolean(workEntry.subagentResult) ||
      Boolean(workEntry.subagentPath) ||
      Boolean(workEntry.subagentThreadId);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setUserOverrodeOpen(true);
    setOpen(nextOpen);
  }, []);

  return (
    <Collapsible className="rounded-lg px-1 py-0.5" open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger
        className={cn(
          "flex min-h-6 w-full items-start gap-2 rounded-md px-0 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !hasNestedContent && "cursor-default",
        )}
        disabled={!hasNestedContent}
      >
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-ui leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground", workToneClass(workEntry.tone))}>{heading}</span>
            {preview && <span className="text-muted-foreground"> - {preview}</span>}
          </p>
          {(workEntry.subagentType || workEntry.subagentModel || workEntry.subagentThreadId) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {workEntry.subagentType && (
                <span className={WORK_META_CHIP_CLASS_NAME}>
                  {/* Claude Code 2.1.317 fork sub-agents carry the conversation; label them plainly. */}
                  {workEntry.subagentType === "fork" ? "Fork" : workEntry.subagentType}
                </span>
              )}
              {workEntry.subagentModel && (
                <span className={cn(WORK_META_CHIP_CLASS_NAME, "font-mono")}>
                  {workEntry.subagentModel}
                  {workEntry.reasoningEffort ? " · " + workEntry.reasoningEffort : ""}
                </span>
              )}
              {workEntry.subagentThreadId && (
                <span
                  className={cn(WORK_META_CHIP_CLASS_NAME, "max-w-48 truncate font-mono")}
                  title={workEntry.subagentThreadId}
                >
                  {workEntry.subagentThreadId}
                </span>
              )}
            </div>
          )}
        </div>
        {hasNestedContent && (
          <ChevronDownIcon
            className={cn(
              "mt-1 size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
              open ? "rotate-180" : "",
            )}
          />
        )}
      </CollapsibleTrigger>
      {hasNestedContent && (
        <CollapsiblePanel>
          <div className="mt-1 ml-7 space-y-2 rounded-lg bg-muted/40 p-3">
            {workEntry.subagentPath &&
              (!isCodexCollaboration || (hasCorrelatedAgentPath && responseRows.length === 0)) && (
                <div>
                  <p className="mb-1 text-2xs font-medium text-muted-foreground">Agent</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {workEntry.subagentPath}
                  </p>
                </div>
              )}
            {workEntry.subagentPrompt && !isCodexCollaboration && (
              <div>
                <p className="mb-1 text-2xs font-medium text-muted-foreground">Tool Call</p>
                <div className="text-ui text-muted-foreground">
                  <ChatMarkdown
                    text={workEntry.subagentPrompt}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              </div>
            )}
            {isCodexCollaboration &&
              responseRows.map((state) => (
                <div key={state.threadId} data-subagent-state={state.status}>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {state.threadId}
                  </p>
                  <p className="text-ui text-muted-foreground">
                    {resolveCodexCollaborationStatusLabel(state.status)}
                    {state.message ? ` - ${state.message}` : ""}
                  </p>
                  {workEntry.subagentPath && workEntry.subagentThreadId === state.threadId ? (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {workEntry.subagentPath}
                    </p>
                  ) : null}
                </div>
              ))}
            {isCodexCollaboration &&
            workEntry.codexCollaborationTool === "wait" &&
            workEntry.status === "completed" &&
            responseRows.length === 0 ? (
              <p className="text-ui text-muted-foreground">No agents completed yet.</p>
            ) : null}
            {isCodexCollaboration && workEntry.subagentStatesTruncated ? (
              <p className="text-xs text-muted-foreground">Additional agent details omitted</p>
            ) : null}
            {workEntry.subagentResult && !isCodexCollaboration && (
              <div>
                <p className="mb-1 text-2xs font-medium text-muted-foreground">Result</p>
                <div className="text-ui text-muted-foreground">
                  <ChatMarkdown
                    text={workEntry.subagentResult}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              </div>
            )}
          </div>
        </CollapsiblePanel>
      )}
    </Collapsible>
  );
});

function diagnosticSourceLabel(workEntry: TimelineWorkEntry): string | undefined {
  const diagnostic = workEntry.diagnostic;
  if (!diagnostic) {
    return undefined;
  }
  const sourceName = diagnostic.sourcePath
    ?.split(/[\\/]/u)
    .filter((part) => part.length > 0)
    .at(-1);
  if (diagnostic.source && sourceName) {
    return `${diagnostic.source}:${sourceName}`;
  }
  return sourceName ?? diagnostic.source;
}

function diagnosticEntriesText(entries: ReadonlyArray<unknown> | undefined): string | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  try {
    return JSON.stringify(entries, null, 2);
  } catch {
    return "[Diagnostic entries could not be serialized]";
  }
}

const DiagnosticWorkEntryRow = memo(function DiagnosticWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
}) {
  const { workEntry } = props;
  const diagnostic = workEntry.diagnostic;
  const [open, setOpen] = useState(false);
  if (!diagnostic) {
    return null;
  }
  const sourceLabel = diagnosticSourceLabel(workEntry);
  const duration =
    diagnostic.durationMs !== undefined ? formatDuration(diagnostic.durationMs) : undefined;
  const statusLabel =
    diagnostic.status === "stopped" && diagnostic.outcome === "success"
      ? "stopped (output replaced)"
      : diagnostic.status;
  const metadata = [
    sourceLabel,
    diagnostic.displayOrder !== undefined ? `order ${diagnostic.displayOrder}` : undefined,
    diagnostic.handlerType,
    duration,
    statusLabel,
  ].filter((value): value is string => Boolean(value));
  const canExpand = Boolean(
    diagnostic.sourcePath ||
    diagnostic.statusMessage ||
    diagnostic.rationale ||
    diagnostic.output ||
    (diagnostic.entries && diagnostic.entries.length > 0),
  );
  const fullOutput = open
    ? (diagnostic.output ?? diagnosticEntriesText(diagnostic.entries))
    : undefined;
  const failed = workEntry.isIssue === true;
  const StatusIcon = failed ? CircleAlertIcon : CheckIcon;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md">
      <CollapsibleTrigger
        disabled={!canExpand}
        className={cn(
          "flex min-h-6 w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          canExpand && "hover:bg-accent/60",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <StatusIcon
            className={cn("size-3.5", failed ? "text-destructive" : "text-faint-foreground")}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui leading-5 text-muted-foreground">
            <span className={failed ? "text-destructive-foreground" : "text-foreground"}>
              {workEntry.label}
            </span>
            {metadata.length > 0 ? <span> — {metadata.join(" · ")}</span> : null}
          </p>
        </div>
        {canExpand ? (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
              open && "rotate-90",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {canExpand ? (
        <CollapsiblePanel>
          <div className="ml-7 space-y-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            {diagnostic.sourcePath ? (
              <div>
                <p className="mb-0.5 text-2xs font-medium">Source</p>
                <p className="break-all font-mono">{diagnostic.sourcePath}</p>
              </div>
            ) : null}
            {diagnostic.statusMessage || diagnostic.rationale ? (
              <div>
                <p className="mb-0.5 text-2xs font-medium">Status</p>
                <p className="whitespace-pre-wrap wrap-break-word">
                  {diagnostic.statusMessage ?? diagnostic.rationale}
                </p>
              </div>
            ) : null}
            {fullOutput ? (
              <div>
                <p className="mb-0.5 text-2xs font-medium">Output</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-sm bg-muted p-2 font-mono">
                  {fullOutput}
                </pre>
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      ) : null}
    </Collapsible>
  );
});

const NestedDiagnosticList = memo(function NestedDiagnosticList(props: {
  diagnostics: ReadonlyArray<TimelineWorkEntry>;
  className?: string;
}) {
  const [revealedCount, setRevealedCount] = useState(WORK_LOG_PAGE_SIZE);
  const normalizedRevealCount = Math.max(WORK_LOG_PAGE_SIZE, revealedCount);
  const visibleDiagnostics = props.diagnostics.slice(
    -Math.min(props.diagnostics.length, normalizedRevealCount),
  );
  const hiddenCount = props.diagnostics.length - visibleDiagnostics.length;
  const hasOverflow = props.diagnostics.length > WORK_LOG_PAGE_SIZE;

  return (
    <div className={cn("ml-5 border-l border-border pl-2", props.className)}>
      {hasOverflow ? (
        <div className="flex items-center justify-between gap-2 px-1 py-0.5">
          <p className="text-2xs font-medium text-muted-foreground">
            Diagnostics ({props.diagnostics.length})
          </p>
          <button
            type="button"
            className="rounded-sm text-2xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setRevealedCount((current) =>
                current >= props.diagnostics.length
                  ? WORK_LOG_PAGE_SIZE
                  : Math.min(props.diagnostics.length, current + WORK_LOG_PAGE_SIZE),
              );
            }}
          >
            {hiddenCount === 0
              ? "Show less"
              : `Show ${Math.min(WORK_LOG_PAGE_SIZE, hiddenCount)} more`}
          </button>
        </div>
      ) : null}
      {visibleDiagnostics.map((diagnostic) => (
        <DiagnosticWorkEntryRow key={`nested-diagnostic:${diagnostic.id}`} workEntry={diagnostic} />
      ))}
    </div>
  );
});

const WorkEntryRow = memo(function WorkEntryRow(props: {
  timestampFormat: TimestampFormat;
  workEntry: TimelineWorkEntry;
  expandMcpToolCalls: boolean;
  expandMcpByDefault: boolean;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  showFileChangeDiffsInline: boolean;
  chatDiffContext: ChatDiffContext;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { workEntry } = props;
  const { threadId } = useTimelineRowContext();
  if (workEntry.activityKind === "native.aside") {
    return (
      <details className="my-2 rounded-lg border p-3">
        <summary>{workEntry.label}</summary>
        <p className="mt-2 whitespace-pre-wrap">{workEntry.detail}</p>
      </details>
    );
  }
  const timestamp = (className: string) => (
    <time
      dateTime={workEntry.createdAt}
      title={new Date(workEntry.createdAt).toLocaleString()}
      className={cn(
        "text-2xs tabular-nums text-muted-foreground opacity-0 group-hover/work-entry:opacity-100 group-focus-within/work-entry:opacity-100 pointer-coarse:opacity-100",
        className,
      )}
    >
      {formatTimestamp(workEntry.createdAt, props.timestampFormat)}
    </time>
  );
  // A bordered MCP card spans the full row and keeps its time in the duration tooltip; a
  // time in the shared right gutter overlapped the card's corner whenever it was wider.
  const mcpCard =
    !workEntry.diagnostic && workEntry.itemType === "mcp_tool_call" && props.expandMcpToolCalls;
  const ownsTimestamp = mcpCard || Boolean(workEntry.userInput);
  const row = workEntry.userInput ? (
    <UserInputCard userInput={workEntry.userInput} timestamp={timestamp("shrink-0")} />
  ) : workEntry.mcpApp && threadId ? (
    <McpAppFrame app={workEntry.mcpApp} threadId={threadId} />
  ) : workEntry.htmlRender ? (
    <HtmlRenderFrame reference={workEntry.htmlRender} onImageExpand={props.onImageExpand} />
  ) : workEntry.diagnostic ? (
    <DiagnosticWorkEntryRow workEntry={workEntry} />
  ) : workEntry.itemType === "collab_agent_tool_call" ? (
    <SubagentWorkEntryRow
      workEntry={workEntry}
      turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId}
      workspaceRoot={props.workspaceRoot}
      markdownCwd={props.markdownCwd}
    />
  ) : mcpCard ? (
    <McpToolCallGroupCard
      entries={[workEntry]}
      expandByDefault={props.expandMcpByDefault}
      markdownCwd={props.markdownCwd}
      timestampFormat={props.timestampFormat}
      onImageExpand={props.onImageExpand}
    />
  ) : (
    <SimpleWorkEntryRow
      workEntry={workEntry}
      turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId}
      workspaceRoot={props.workspaceRoot}
      resolvedTheme={props.resolvedTheme}
      showFileChangeDiffsInline={props.showFileChangeDiffsInline}
      chatDiffContext={props.chatDiffContext}
      onOpenTurnDiff={props.onOpenTurnDiff}
    />
  );

  return (
    <div className={cn("group/work-entry relative min-w-0", !ownsTimestamp && "pr-14")}>
      {ownsTimestamp ? null : timestamp("absolute right-1 top-1.5")}
      {row}
      {/* MCP cards list their calls' diagnostics under each call. */}
      {!mcpCard && workEntry.nestedDiagnostics && workEntry.nestedDiagnostics.length > 0 ? (
        <NestedDiagnosticList diagnostics={workEntry.nestedDiagnostics} />
      ) : null}
    </div>
  );
});

// Session cards fold their calls' rows, so correlated hook and review results move into the card.
const renderAutomationDiagnostics = (diagnostics: ReadonlyArray<TimelineWorkEntry>) => (
  <NestedDiagnosticList diagnostics={diagnostics} className="ml-0" />
);

// ── Timeline rows ────────────────────────────────────────────────────

type TimelineRevertImpact = ReturnType<typeof computeRevertImpact>;

/**
 * Per-row inputs that live outside the row object (expansion flags, turn
 * diff summaries, revert popover state). Built per row and reused while the
 * row's `rowVersion` is unchanged, so a memoized row re-renders only when
 * something it reads changed.
 */
type TimelineRowExternals =
  | {
      kind: "work";
      expandedCount: number;
      collapseOverride: boolean | undefined;
      turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
      chatDiffContext: ChatDiffContext;
    }
  | {
      kind: "user-message";
      canRevert: boolean;
      popoverOpen: boolean;
      revertImpact: TimelineRevertImpact | null;
      presetRestoreFiles: boolean | undefined;
    }
  | {
      kind: "assistant-message";
      turnSummary: TurnDiffSummary | undefined;
      presentationOverride: ChangedFilesPresentation | undefined;
      isNewest: boolean;
      /** The last assistant message in the timeline: its code blocks never fold. */
      /** Part of the latest turn, whose code blocks never fold. */
      inLatestTurn: boolean;
      /** Set on a turn's last reply when the turn missed the prompt cache. */
      cacheMiss: TurnCacheSummary | undefined;
    }
  | { kind: "command"; expanded: boolean }
  | { kind: "working"; ribbonActive: boolean }
  | { kind: "static" };

type TimelineRowExternalsOf<K extends TimelineRowExternals["kind"]> = Extract<
  TimelineRowExternals,
  { kind: K }
>;

interface TimelineRowActions {
  onToggleWorkGroup: (groupId: string, paginatedEntryCount: number) => void;
  onSetWorkGroupExpanded: (groupId: string, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onImageActionMenu: (item: ImageAttachmentActionItem, position: { x: number; y: number }) => void;
  onToggleCommandExecution: (commandExecutionId: string) => void;
  onToggleAllDirectories: () => void;
  onToggleFileChangeDiff: (workEntryId: string) => void;
  onOpenFileChangeDiff: (fileChangeId: OrchestrationFileChangeId, filePath?: string) => void;
  setRevertPopoverOpen: (messageId: MessageId, open: boolean) => void;
  confirmRevert: (messageId: MessageId, restoreFiles: boolean) => void;
  setChangedFilesPresentationOverrides: Dispatch<
    SetStateAction<Readonly<Record<string, ChangedFilesPresentation>>>
  >;
  startRibbon: (origin: RibbonPoint) => void;
  quoteAssistantMessage: (messageId: MessageId, text: string) => void;
}

/**
 * Slow-changing values every row reads (settings, theme, workspace, stable
 * actions). A change re-renders every row, so per-row inputs stay out of it.
 */
interface TimelineRowContextValue {
  threadId: ThreadId | null;
  nativeSessionCapabilities: ProviderSessionCapabilities | null;
  expandMcpToolCalls: boolean;
  expandMcpToolCallCardsByDefault: boolean;
  showReasoningExpanded: boolean;
  showFileChangeDiffsInline: boolean;
  collapseCompletedWorkLogs: boolean;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  isGitRepo: boolean;
  promptLinkRepository: PromptLinkRepository | null;
  canRestoreFiles: boolean | undefined;
  revertDisabledReason: string | null;
  revertPreferenceKey: string | undefined;
  allDirectoriesExpanded: boolean;
  usesCustomImageContextMenu: boolean;
  hasImageActionMenu: boolean;
  canSetWorkGroupExpanded: boolean;
  isWorking: boolean;
  reducedMotion: boolean;
  /** User bubbles render code spans, fences and bold (the rich-text composer setting). */
  userMessageMarkup: boolean;
  canQuoteAssistantMessages: boolean;
  grabButtonRef: MutableRefObject<HTMLButtonElement | null>;
  actions: TimelineRowActions;
}

const TimelineRowContext = createContext<TimelineRowContextValue | null>(null);

function useTimelineRowContext(): TimelineRowContextValue {
  const value = useContext(TimelineRowContext);
  if (!value) throw new Error("Timeline rows must render inside MessagesTimeline.");
  return value;
}

type WorkTimelineRow = Extract<TimelineRow, { kind: "work" }>;
type MessageTimelineRow = Extract<TimelineRow, { kind: "message" }>;
type ProposedPlanTimelineRow = Extract<TimelineRow, { kind: "proposed-plan" }>;
type CommandTimelineRow = Extract<TimelineRow, { kind: "command" }>;
type WorkingTimelineRow = Extract<TimelineRow, { kind: "working" }>;

function TimelineRowErrorFallback(props: { error: unknown }) {
  return (
    <div
      role="alert"
      data-slot="timeline-row-error"
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">This entry could not be displayed</span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => copyErrorReport(props.error, "Surface: timeline-row")}
      >
        Copy error report
      </Button>
    </div>
  );
}

const renderTimelineRowErrorFallback = (props: SurfaceErrorFallbackProps) => (
  <TimelineRowErrorFallback error={props.error} />
);

/**
 * One timeline row. Memoized on the row object (reused while its entries
 * are unchanged) and its externals (reused while `rowVersion` is unchanged),
 * so a streaming delta re-renders only the row it touched. A row that throws
 * renders a fallback in place while the rest of the timeline stays usable.
 */
const TimelineRowView = memo(function TimelineRowView(props: {
  row: TimelineRow;
  externals: TimelineRowExternals;
  rowVersion: string;
}) {
  "use memo";
  const testRenderCountProps = useTestRenderCountProps();
  const { row } = props;
  return (
    <TimelineRowWrapper
      row={row}
      compactBottom={(row.kind === "work" || row.kind === "command") && row.compactBottom === true}
      testRenderCountProps={testRenderCountProps}
    >
      <SurfaceErrorBoundary
        name="timeline-row"
        resetKeys={[props.row, props.rowVersion]}
        fallback={renderTimelineRowErrorFallback}
      >
        <TimelineRowContent row={props.row} externals={props.externals} />
      </SurfaceErrorBoundary>
    </TimelineRowWrapper>
  );
});

function TimelineRowContent(props: { row: TimelineRow; externals: TimelineRowExternals }) {
  "use memo";
  const { row, externals } = props;
  switch (row.kind) {
    case "work":
      return externals.kind === "work" ? (
        <WorkGroupRowContent row={row} externals={externals} />
      ) : null;
    case "message":
      if (row.message.role === "user") {
        return externals.kind === "user-message" ? (
          <UserMessageRowContent row={row} externals={externals} />
        ) : null;
      }
      if (row.message.role === "assistant") {
        return externals.kind === "assistant-message" ? (
          <AssistantMessageRowContent row={row} externals={externals} />
        ) : null;
      }
      return null;
    case "proposed-plan":
      return <ProposedPlanRowContent row={row} />;
    case "command":
      return externals.kind === "command" ? (
        <CommandRowContent row={row} externals={externals} />
      ) : null;
    case "working":
      return externals.kind === "working" ? (
        <WorkingRowContent row={row} externals={externals} />
      ) : null;
  }
}

function WorkGroupRowContent(props: {
  row: WorkTimelineRow;
  externals: TimelineRowExternalsOf<"work">;
}) {
  "use memo";
  const { row, externals } = props;
  const {
    actions,
    canSetWorkGroupExpanded,
    collapseCompletedWorkLogs,
    expandMcpToolCallCardsByDefault,
    expandMcpToolCalls,
    markdownCwd,
    resolvedTheme,
    showFileChangeDiffsInline,
    timestampFormat,
    workspaceRoot,
  } = useTimelineRowContext();
  const groupId = row.id;
  const appEntries = row.groupedEntries.filter((entry) => entry.mcpApp);
  const logEntries = row.groupedEntries.filter((entry) => !entry.mcpApp);
  const groupState = resolveWorkGroupRenderState(logEntries, externals.expandedCount);
  const entryProps = {
    timestampFormat,
    expandMcpToolCalls,
    expandMcpByDefault: expandMcpToolCallCardsByDefault,
    turnDiffSummaryByTurnId: externals.turnDiffSummaryByTurnId,
    workspaceRoot,
    markdownCwd,
    resolvedTheme,
    showFileChangeDiffsInline,
    chatDiffContext: externals.chatDiffContext,
    onOpenTurnDiff: actions.onOpenTurnDiff,
    onImageExpand: actions.onImageExpand,
  };
  const appRows = appEntries.map((entry) => (
    <WorkEntryRow key={`app:${entry.id}`} workEntry={entry} {...entryProps} />
  ));
  if (!logEntries.length) return <div className="min-w-0 space-y-2">{appRows}</div>;
  // Automation cards stay visible across turns; only their steps collapse.
  if (row.automationSurface) {
    return (
      <div className="min-w-0 px-1 py-0.5">
        <AutomationSessionCard
          surface={row.automationSurface}
          entries={row.groupedEntries}
          active={row.automationActive ?? false}
          renderDiagnostics={renderAutomationDiagnostics}
          timestampFormat={timestampFormat}
          markdownCwd={markdownCwd}
          onImageExpand={actions.onImageExpand}
        />
      </div>
    );
  }
  // MCP cards stay visible across turns like automation cards; only their rows expand.
  if (row.mcpGroup && !appEntries.length) {
    return (
      <div className="min-w-0 px-1 py-0.5">
        <McpToolCallGroupCard
          entries={logEntries}
          expandByDefault={expandMcpToolCallCardsByDefault}
          markdownCwd={markdownCwd}
          timestampFormat={timestampFormat}
          onImageExpand={actions.onImageExpand}
        />
      </div>
    );
  }
  const expanded = externals.collapseOverride ?? !(row.isPriorTurn && collapseCompletedWorkLogs);
  const canCollapse = row.isPriorTurn && canSetWorkGroupExpanded;
  const standaloneExpandedMcpEntry =
    row.groupedEntries.length === 1 &&
    (row.groupedEntries[0]?.usageLimited ||
      row.groupedEntries[0]?.htmlRender ||
      row.groupedEntries[0]?.mcpApp ||
      row.groupedEntries[0]?.activityKind === "user-input.resolved" ||
      row.groupedEntries[0]?.userInput)
      ? row.groupedEntries[0]
      : resolveStandaloneExpandedMcpWorkEntry(row.groupedEntries, {
          settingsExpandMcpToolCalls: expandMcpToolCalls,
        });

  if (!appEntries.length && standaloneExpandedMcpEntry) {
    return (
      <div className="min-w-0 px-1 py-0.5">
        <WorkEntryRow workEntry={standaloneExpandedMcpEntry} {...entryProps} />
      </div>
    );
  }

  const log = !expanded ? (
    <div className="min-w-0 px-1 py-0.5">
      <button
        type="button"
        aria-expanded={false}
        data-slot="work-group-summary"
        className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => actions.onSetWorkGroupExpanded(groupId, true)}
      >
        <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />
        <span className="min-w-0 truncate">{row.workSummary}</span>
      </button>
    </div>
  ) : (
    <div className="rounded-xl border border-border bg-card/50 px-2 py-1.5">
      {(groupState.showHeader || canCollapse) && (
        <div className="mb-1 flex min-h-6 items-center justify-between gap-2 px-0.5">
          {canCollapse ? (
            <button
              type="button"
              aria-expanded
              className="flex min-w-0 items-center gap-1 rounded-sm text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => actions.onSetWorkGroupExpanded(groupId, false)}
            >
              <ChevronDownIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-faint-foreground"
              />
              <span className="truncate">{row.workSummary}</span>
            </button>
          ) : (
            <SectionLabel as="span" count={logEntries.length} className="min-h-0">
              {groupState.groupLabel}
            </SectionLabel>
          )}
          {groupState.hasOverflow && (
            <button
              type="button"
              className="shrink-0 rounded-sm text-2xs text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => actions.onToggleWorkGroup(groupId, groupState.paginatedEntryCount)}
            >
              {groupState.isExpanded
                ? "Show less"
                : `Show ${Math.min(WORK_LOG_PAGE_SIZE, groupState.hiddenCount)} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {groupState.visibleEntries.map((workEntry) => (
          <WorkEntryRow key={`work-row:${workEntry.id}`} workEntry={workEntry} {...entryProps} />
        ))}
      </div>
    </div>
  );
  return appRows.length ? (
    <div className="min-w-0 space-y-2">
      {appRows}
      {log}
    </div>
  ) : (
    log
  );
}

function UserMessageRowContent(props: {
  row: MessageTimelineRow;
  externals: TimelineRowExternalsOf<"user-message">;
}) {
  "use memo";
  const { row, externals } = props;
  const {
    actions,
    canRestoreFiles,
    hasImageActionMenu,
    isGitRepo,
    nativeSessionCapabilities,
    promptLinkRepository,
    resolvedTheme,
    revertDisabledReason,
    revertPreferenceKey,
    threadId,
    timestampFormat,
    userMessageMarkup,
    usesCustomImageContextMenu,
    workspaceRoot,
  } = useTimelineRowContext();
  const find = useContext(ThreadFindContext);
  const forceExpandedForFind = find?.entryId === row.id;
  if (String(row.message.id).startsWith("resume:"))
    return (
      <div
        className="my-4 flex items-center gap-3 text-2xs font-medium text-muted-foreground"
        role="separator"
      >
        <span className="h-px flex-1 bg-border" />
        Resumed after restart
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  const userImages = (row.message.attachments ?? []).filter(
    (attachment) => attachment.type === "image",
  );
  const userFiles = (row.message.attachments ?? []).filter(
    (attachment) => attachment.type === "file",
  );
  // A message-mode answer is delivered as JSON for the provider; show the chosen answers.
  const displayedUserMessage = deriveDisplayedUserMessageState(
    answerDeliveryDisplayText(row.message) ?? row.message.text,
  );
  const terminalContexts = displayedUserMessage.contexts;
  const canRevertAgentWork = externals.canRevert;
  // Images sent without words show as media, not as a bubble around them.
  const mediaOnly =
    userImages.length > 0 &&
    userFiles.length === 0 &&
    displayedUserMessage.attachedFilePaths.length === 0 &&
    terminalContexts.length === 0 &&
    displayedUserMessage.visibleText.trim() === "";
  // A lone image keeps its own shape; a fixed crop hides most of a wide screenshot.
  const loneImage = mediaOnly && userImages.length === 1;
  // Several images sent without words share one rounded shape, split by hairlines.
  const collage = mediaOnly && userImages.length > 1;
  return (
    <div className="group/user-message flex flex-col items-end">
      {row.userInput ? (
        // The answer turn keeps its user row, and with it revert, fork and turn navigation.
        <div className="w-full" data-slot="user-message-answer">
          <UserInputCard userInput={row.userInput} timestamp={null} />
        </div>
      ) : (
        <div
          className={cn(
            "max-w-full sm:max-w-[85%]",
            !mediaOnly && "rounded-xl rounded-br-md border border-border bg-secondary px-4 py-2.5",
          )}
          data-slot="user-message-bubble"
          data-media-only={mediaOnly ? "" : undefined}
        >
          {userFiles.map((file) => (
            <AttachmentFileChip key={file.id} file={file} />
          ))}
          {userImages.length > 0 && (
            <div
              className={cn(
                "grid",
                loneImage
                  ? "max-w-full"
                  : collage
                    ? cn(
                        USER_MEDIA_EDGE_CLASS_NAME,
                        "w-80 max-w-full gap-px overflow-hidden rounded-2xl bg-black/9 dark:bg-white/12",
                        userImages.length === 2
                          ? "auto-rows-[12rem] grid-cols-2"
                          : userImages.length === 3
                            ? "auto-rows-[calc(6rem-0.5px)] grid-cols-[3fr_2fr]"
                            : "auto-rows-[6rem] grid-cols-2",
                      )
                    : "mb-2 max-w-[420px] grid-cols-2 gap-2",
              )}
            >
              {userImages.map(
                (image: NonNullable<TimelineMessage["attachments"]>[number], index) => {
                  const previewUrl = image.previewUrl;
                  return (
                    <div
                      key={image.id}
                      className={cn(
                        loneImage
                          ? cn(
                              USER_MEDIA_EDGE_CLASS_NAME,
                              "overflow-hidden rounded-2xl bg-background/70",
                            )
                          : collage
                            ? cn(
                                "overflow-hidden bg-background",
                                userImages.length === 3 && index === 0 && "row-span-2",
                                userImages.length > 3 &&
                                  userImages.length % 2 === 1 &&
                                  index === userImages.length - 1 &&
                                  "col-span-2",
                              )
                            : "overflow-hidden rounded-lg border border-border/80 bg-background/70",
                      )}
                    >
                      {previewUrl ? (
                        <button
                          type="button"
                          className="block h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${image.name}`}
                          onContextMenu={(event) => {
                            if (!usesCustomImageContextMenu || !hasImageActionMenu) return;
                            event.preventDefault();
                            event.stopPropagation();
                            actions.onImageActionMenu(
                              {
                                src: image.sourceUrl ?? previewUrl,
                                name: image.name,
                                mimeType: image.mimeType,
                                ...(image.sourceBlob ? { sourceBlob: image.sourceBlob } : {}),
                              },
                              { x: event.clientX, y: event.clientY },
                            );
                          }}
                          onClick={() => {
                            const preview = buildExpandedImagePreview(userImages, image.id);
                            if (!preview) return;
                            actions.onImageExpand(preview);
                          }}
                        >
                          <AttachmentImage
                            name={image.name}
                            mimeType={image.mimeType}
                            sourceBlob={image.sourceBlob}
                            src={previewUrl}
                            alt={image.name}
                            className={cn(
                              "block object-cover",
                              // A fixed height keeps the row from growing when the image loads.
                              loneImage
                                ? "h-48 w-auto min-w-24 max-w-full"
                                : collage
                                  ? "size-full"
                                  : "h-full max-h-[220px] w-full",
                            )}
                            draggable={false}
                          />
                        </button>
                      ) : (
                        <div
                          className={cn(
                            "flex min-h-18 items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground",
                            loneImage && "h-48 w-64 max-w-full",
                            collage && "h-full",
                          )}
                        >
                          {image.name}
                        </div>
                      )}
                    </div>
                  );
                },
              )}
            </div>
          )}
          {displayedUserMessage.attachedFilePaths.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {displayedUserMessage.attachedFilePaths.map((filePath) => {
                const displayPath = relativePathForDisplay(filePath, workspaceRoot);
                return (
                  <span
                    key={filePath}
                    className={COMPOSER_INLINE_CHIP_CLASS_NAME}
                    title={displayPath}
                  >
                    <VscodeEntryIcon pathValue={filePath} kind="file" theme={resolvedTheme} />
                    <span className="max-w-[320px] truncate">{displayPath}</span>
                  </span>
                );
              })}
            </div>
          )}
          {(displayedUserMessage.visibleText.trim().length > 0 || terminalContexts.length > 0) && (
            <>
              {/* The copy button below uses copyText, which is derived before
                    visual collapse, so collapsed messages still copy in full. */}
              <TimelineUserMessageBody
                key={row.message.id}
                text={displayedUserMessage.visibleText}
                skillCall={row.message.skillCall}
                terminalContexts={terminalContexts}
                markup={userMessageMarkup}
                forceExpandedForFind={forceExpandedForFind}
              />
            </>
          )}
        </div>
      )}
      <div className="mt-1.5 flex min-h-7 items-center gap-1 pr-1">
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/user-message:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
          {displayedUserMessage.copyText && (
            <MessageCopyButton text={displayedUserMessage.copyText} />
          )}
          {displayedUserMessage.copyText && (
            <PromptLinkCopyButton
              prompt={displayedUserMessage.copyText}
              repository={promptLinkRepository}
            />
          )}
          {threadId &&
            row.message.turnId &&
            nativeSessionCapabilities?.actions.some(
              (action) =>
                ["fileCheckpointing", "nativeFork"].includes(action.action) && action.supported,
            ) && (
              <NativeFilePreview
                threadId={threadId}
                turnId={row.message.turnId}
                generation={nativeSessionCapabilities.generation}
                filePreview={nativeSessionCapabilities.actions.some(
                  (action) => action.action === "fileCheckpointing" && action.supported,
                )}
                nativeFork={
                  isGitRepo &&
                  nativeSessionCapabilities.actions.some(
                    (action) => action.action === "nativeFork" && action.supported,
                  )
                }
              />
            )}
          {canRevertAgentWork && (
            <UserMessageRevertPopover
              open={externals.popoverOpen}
              onOpenChange={(open) => actions.setRevertPopoverOpen(row.message.id, open)}
              disabledReason={revertDisabledReason}
              nativeFileRevert={
                !isGitRepo &&
                nativeSessionCapabilities?.actions.some(
                  (action) => action.action === "fileCheckpointing" && action.supported,
                )
              }
              nativeFileTarget={
                threadId && row.message.turnId && nativeSessionCapabilities
                  ? {
                      threadId,
                      turnId: row.message.turnId,
                      generation: nativeSessionCapabilities.generation,
                    }
                  : undefined
              }
              canRestoreFiles={canRestoreFiles === true}
              impact={externals.revertImpact}
              presetRestoreFiles={externals.presetRestoreFiles}
              preferenceKey={revertPreferenceKey}
              onConfirm={(restoreFiles) => actions.confirmRevert(row.message.id, restoreFiles)}
            />
          )}
        </div>
        <p className="text-2xs text-muted-foreground tabular-nums">
          {formatTimestamp(row.message.createdAt, timestampFormat)}
        </p>
      </div>
    </div>
  );
}

function AssistantMessageRowContent(props: {
  row: MessageTimelineRow;
  externals: TimelineRowExternalsOf<"assistant-message">;
}) {
  "use memo";
  const { row, externals } = props;
  const {
    actions,
    canQuoteAssistantMessages,
    markdownCwd,
    showReasoningExpanded,
    timestampFormat,
  } = useTimelineRowContext();
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const settledText = !row.message.streaming && row.message.text.length > 0;
  const messageId = row.message.id;
  const rawText = row.message.text;
  const reasoning = messageReasoningContent(row.message);
  const reasoningText = reasoning.text;
  const reasoningTokens = row.message.reasoningTokens ?? 0;
  const isStreamingReasoning =
    Boolean(row.message.streaming) && row.message.text.length === 0 && Boolean(reasoningText);
  return (
    <>
      {row.showCompletionDivider && (
        <div className="my-3 flex flex-wrap items-center gap-3" role="separator">
          {row.completionStartedAt ? (
            <time
              dateTime={row.completionStartedAt}
              className="text-2xs text-muted-foreground tabular-nums"
            >
              Started {formatTimestamp(row.completionStartedAt, timestampFormat)}
            </time>
          ) : null}
          <span className="h-px flex-1 bg-border" />
          <SectionLabel as="span" className="min-h-0">
            {row.completionSummary ?? "Response"}
          </SectionLabel>
          <span className="h-px flex-1 bg-border" />
          {row.completionCompletedAt ? (
            <time
              dateTime={row.completionCompletedAt}
              className="text-2xs text-muted-foreground tabular-nums"
            >
              Finished {formatTimestamp(row.completionCompletedAt, timestampFormat)}
            </time>
          ) : null}
        </div>
      )}
      <div className="group/assistant-message min-w-0 px-1 py-0.5">
        {reasoningText || reasoningTokens > 0 ? (
          <ReasoningSection
            reasoningText={reasoningText}
            textRevision={reasoning.revision}
            reasoningTokens={reasoningTokens}
            reasoningTokensEstimated={row.message.reasoningTokensEstimated}
            hideTokens
            defaultExpanded={showReasoningExpanded}
            isStreaming={isStreamingReasoning}
            cwd={markdownCwd}
          />
        ) : null}
        <div
          className={
            /^★ Insight(?:\s|─)/mu.test(messageText)
              ? "[&_.chat-markdown_p]:whitespace-pre-line"
              : undefined
          }
        >
          <ChatMarkdown
            text={messageText}
            textRevision={messageTextRevision(row.message)}
            cwd={markdownCwd}
            isStreaming={Boolean(row.message.streaming)}
            // Blocks of the turn the user is reading stay open; they fold once
            // the user starts a new turn.
            foldCodeBlocks={!row.message.streaming && !externals.inLatestTurn}
            showStreamingCaret
          />
        </div>
        <AssistantChangedFiles externals={externals} />
        <div
          data-assistant-quote-exclude
          className="mt-1.5 flex min-h-7 items-center justify-between gap-2"
        >
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
            <p
              data-slot="assistant-message-meta"
              className="whitespace-nowrap text-2xs text-muted-foreground tabular-nums"
            >
              <LiveMessageMeta
                durationStart={
                  row.showCompletionDivider
                    ? (row.completionStartedAt ?? row.durationStart)
                    : row.durationStart
                }
                completedAt={
                  row.showCompletionDivider
                    ? (row.completionCompletedAt ?? row.message.completedAt)
                    : row.message.completedAt
                }
                streaming={row.message.streaming}
              />
              <MessageTokenUsage
                turnId={row.message.turnId}
                reasoningTokens={row.message.reasoningTokens}
                reasoningEstimated={row.message.reasoningTokensEstimated}
                streaming={row.message.streaming}
              />
            </p>
            {externals.cacheMiss ? <PromptCacheMissPill turn={externals.cacheMiss} /> : null}
          </div>
          {/* Always laid out, only faded: hovering never shifts the row. */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/assistant-message:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
            {settledText ? <MessageCopyButton text={rawText} /> : null}
            {settledText && canQuoteAssistantMessages ? (
              <AssistantMessageActions
                onQuote={() => actions.quoteAssistantMessage(messageId, rawText)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function AssistantChangedFiles(props: { externals: TimelineRowExternalsOf<"assistant-message"> }) {
  "use memo";
  const { externals } = props;
  const { actions, allDirectoriesExpanded, resolvedTheme, threadId } = useTimelineRowContext();
  const { turnSummary } = externals;
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);
  const presentationKey = `${threadId ?? "unknown"}:${turnSummary.turnId}`;
  const defaultPresentation = resolveChangedFilesPresentation({
    fileCount: checkpointFiles.length,
    changedLineCount: changedLineCount(summaryStat),
    isNewest: externals.isNewest,
  });
  const presentation = externals.presentationOverride ?? defaultPresentation;
  const isExpanded = presentation === "expanded";
  const togglePresentation = () => {
    actions.setChangedFilesPresentationOverrides((current) => ({
      ...current,
      [presentationKey]: isExpanded
        ? defaultPresentation === "expanded"
          ? "collapsed"
          : defaultPresentation
        : "expanded",
    }));
  };
  return (
    <div className="relative mt-3 rounded-xl border border-border bg-card p-2.5">
      <div className="sticky top-0 z-2 -mx-2.5 -mt-2.5 mb-1.5 flex items-center justify-between gap-2 rounded-t-xl border-b border-border bg-card/95 px-2.5 py-1 backdrop-blur-sm supports-backdrop-filter:bg-card/85">
        <SectionLabel as="span" count={checkpointFiles.length} className="min-w-0">
          <span>Changed files</span>
          {hasNonZeroStat(summaryStat) && (
            <span className="ms-2 font-normal">
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </span>
          )}
          <span className="sr-only"> ({changedFileCountLabel})</span>
        </SectionLabel>
        <div className="flex items-center gap-1">
          {isExpanded ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => actions.onToggleAllDirectories()}
            >
              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-expanded={isExpanded}
            onClick={togglePresentation}
          >
            {isExpanded ? "Show less" : "Show more"}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-(--duration-fast)",
                isExpanded && "rotate-180",
              )}
            />
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => actions.onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      {presentation === "expanded" ? (
        <ChangedFilesTree
          key={`changed-files-tree:${turnSummary.turnId}`}
          turnId={turnSummary.turnId}
          files={checkpointFiles}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme={resolvedTheme}
          onOpenTurnDiff={actions.onOpenTurnDiff}
        />
      ) : presentation === "compact" ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {checkpointFiles.slice(0, CHANGED_FILES_COMPACT_PREVIEW_COUNT).map((file) => (
            <FileChip
              key={`${turnSummary.turnId}:${file.path}`}
              path={file.path}
              theme={resolvedTheme}
              className="max-w-56"
              onClick={() => actions.onOpenTurnDiff(turnSummary.turnId, file.path)}
            />
          ))}
          {checkpointFiles.length > CHANGED_FILES_COMPACT_PREVIEW_COUNT ? (
            <span className="inline-flex h-6 items-center px-1 text-2xs text-muted-foreground tabular-nums">
              +{checkpointFiles.length - CHANGED_FILES_COMPACT_PREVIEW_COUNT}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProposedPlanRowContent(props: { row: ProposedPlanTimelineRow }) {
  "use memo";
  const { row } = props;
  const { markdownCwd, workspaceRoot } = useTimelineRowContext();
  const find = useContext(ThreadFindContext);
  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        forceExpanded={find?.entryId === row.id}
        planMarkdown={row.proposedPlan.planMarkdown}
        cwd={markdownCwd}
        workspaceRoot={workspaceRoot}
      />
    </div>
  );
}

function CommandRowContent(props: {
  row: CommandTimelineRow;
  externals: TimelineRowExternalsOf<"command">;
}) {
  "use memo";
  const { row, externals } = props;
  const { actions, isWorking, threadId, timestampFormat, workspaceRoot } = useTimelineRowContext();
  return (
    <div className="min-w-0 px-1 py-0.5">
      <CommandTranscriptCard
        threadId={threadId}
        execution={row.commandExecution}
        expanded={externals.expanded}
        timestampFormat={timestampFormat}
        workspaceRoot={workspaceRoot}
        threadWorking={isWorking}
        onToggle={() => actions.onToggleCommandExecution(row.commandExecution.id)}
      />
      {row.nestedDiagnostics && row.nestedDiagnostics.length > 0 ? (
        <NestedDiagnosticList diagnostics={row.nestedDiagnostics} className="mt-1" />
      ) : null}
    </div>
  );
}

function WorkingRowContent(props: {
  row: WorkingTimelineRow;
  externals: TimelineRowExternalsOf<"working">;
}) {
  "use memo";
  const { row, externals } = props;
  const { actions, grabButtonRef, reducedMotion } = useTimelineRowContext();
  return (
    <div className="py-0.5 pl-1.5">
      {row.thought ? (
        <div
          data-working-thought=""
          className="flex min-w-0 items-start gap-2 pt-1 text-ui text-muted-foreground"
        >
          <BrainIcon aria-hidden className="mt-[0.2em] size-3.5 shrink-0 text-faint-foreground" />
          <span className="min-w-0 line-clamp-4 wrap-break-word">{row.thought}</span>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 pt-1 text-ui text-muted-foreground">
        <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5">
          <span className="size-1 rounded-full bg-faint-foreground motion-safe:animate-status-pulse" />
          <span className="size-1 rounded-full bg-faint-foreground motion-safe:animate-status-pulse motion-safe:[animation-delay:200ms]" />
          <span className="size-1 rounded-full bg-faint-foreground motion-safe:animate-status-pulse motion-safe:[animation-delay:400ms]" />
        </span>
        {reducedMotion ? (
          <span className="shrink-0 tabular-nums">
            <LiveWorkingLabel startedAt={row.createdAt} />
          </span>
        ) : (
          // Picks the label up as a steerable ribbon; looks like plain text at rest.
          <button
            ref={grabButtonRef}
            type="button"
            data-working-ribbon-grab=""
            // Static: a focused control whose name ticked every second
            // would be re-announced by screen readers on each tick.
            aria-label="Working. Press to steer the text"
            className={cn(
              "m-0 shrink-0 cursor-grab appearance-none rounded-sm border-0 bg-transparent p-0 font-[inherit] leading-[inherit] tracking-[inherit] text-inherit tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              externals.ribbonActive && "invisible",
            )}
            onKeyDown={(event) => {
              // Focus returns here while the key that grabbed the ribbon
              // may still be held (it dropped for lack of room); its
              // autorepeat must not pick the ribbon straight back up.
              // Chromium already ignores repeats here; other engines may not.
              if (event.repeat && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
              }
            }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              actions.startRibbon({ x: rect.right, y: rect.top + rect.height / 2 });
            }}
          >
            <LiveWorkingLabel startedAt={row.createdAt} />
          </button>
        )}
        {row.activity ? (
          <span className="min-w-0 truncate text-muted-foreground">· {row.activity}</span>
        ) : null}
      </div>
    </div>
  );
}

// ── Row building and versions ────────────────────────────────────────

const timelineObjectVersionIds = new WeakMap<object, number>();
let lastTimelineObjectVersionId = 0;

/** A stable id per object identity, for version strings that track references. */
function timelineObjectVersion(value: object | null | undefined): string {
  if (value == null) return "-";
  let id = timelineObjectVersionIds.get(value);
  if (id === undefined) {
    lastTimelineObjectVersionId += 1;
    id = lastTimelineObjectVersionId;
    timelineObjectVersionIds.set(value, id);
  }
  return String(id);
}

function sameRowInputs(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

/**
 * Reuse state for `buildTimelineRows`, held in a `useRef`. A row whose inputs
 * all match by reference keeps its previous object; rows absent from the
 * current build are pruned.
 */
export interface TimelineRowCache {
  structure?: object | undefined;
  parameters?: ReadonlyArray<unknown>;
  structuralDerivations: number;
  contentUpdates: number;
  rows: Map<string, { readonly inputs: ReadonlyArray<unknown>; readonly row: TimelineRow }>;
  result: TimelineRow[] | null;
}

export function createTimelineRowCache(): TimelineRowCache {
  return { rows: new Map(), result: null, structuralDerivations: 0, contentUpdates: 0 };
}

export function buildTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByTurnId?: ReadonlyMap<TurnId, TurnDiffSummary> | undefined;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  liveActivity: LiveWorkActivity | null;
  expandMcpToolCalls: boolean;
  cache: TimelineRowCache;
}): TimelineRow[] {
  const { timelineEntries, cache } = input;
  const structure = timelineEntriesStructure(timelineEntries);
  const parameters = [
    input.completionDividerBeforeEntryId,
    input.completionSummary,
    input.turnDiffSummaryByTurnId,
    input.isWorking,
    input.activeTurnStartedAt,
    input.liveActivity,
    input.expandMcpToolCalls,
  ];
  if (
    structure &&
    cache.structure === structure &&
    cache.result &&
    cache.parameters &&
    sameRowInputs(cache.parameters, parameters) &&
    // Text deltas can reuse row geometry. Lifecycle updates must recalculate
    // completion metadata even when the entry list has the same structure.
    timelineEntries.every((entry) => {
      if (entry.kind !== "message") return true;
      const previous = cache.rows.get(entry.id)?.row;
      return (
        previous?.kind === "message" &&
        previous.message.streaming === entry.message.streaming &&
        previous.message.completedAt === entry.message.completedAt &&
        previous.message.turnId === entry.message.turnId &&
        previous.message.createdAt === entry.message.createdAt
      );
    })
  ) {
    const messages = new Map(
      timelineEntries.flatMap((entry) =>
        entry.kind === "message" ? [[entry.id, entry.message] as const] : [],
      ),
    );
    let changed = false;
    const result = cache.result.map((row) => {
      if (row.kind !== "message") return row;
      const message = messages.get(row.id);
      if (!message || message === row.message) return row;
      changed = true;
      const next = { ...row, message };
      const entry = cache.rows.get(row.id)!;
      const inputs = [...entry.inputs];
      inputs[1] = message;
      cache.rows.set(row.id, { inputs, row: next });
      return next;
    });
    if (changed) {
      cache.contentUpdates++;
      cache.result = result;
    }
    return cache.result;
  }
  cache.structure = structure;
  cache.parameters = parameters;
  cache.structuralDerivations++;
  const nextCacheRows: TimelineRowCache["rows"] = new Map();
  const reuse = <R extends TimelineRow>(
    id: string,
    inputs: ReadonlyArray<unknown>,
    build: () => R,
  ): TimelineRow => {
    const cached = cache.rows.get(id);
    const row = cached && sameRowInputs(cached.inputs, inputs) ? cached.row : build();
    nextCacheRows.set(id, { inputs, row });
    return row;
  };

  const nextRows: TimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  // Rebuild from persisted history, rather than remembering the last completion
  // in component state: this also survives reloads and loading older turns.
  const lastAssistantByTurn = new Map<TurnId, string>();
  const startByTurn = new Map<TurnId, string>();
  const promptStartByMessageId = new Map<string, string>();
  let lastUserAt: string | undefined;
  for (const entry of timelineEntries) {
    if (entry.kind !== "message") continue;
    const message = entry.message;
    if (message.role === "user") lastUserAt = message.createdAt;
    if (lastUserAt) promptStartByMessageId.set(message.id, lastUserAt);
    if (!message.turnId) continue;
    if (!startByTurn.has(message.turnId) && lastUserAt) {
      startByTurn.set(message.turnId, lastUserAt);
    }
    if (message.role === "assistant") lastAssistantByTurn.set(message.turnId, entry.id);
  }
  // Work groups above the newest user message belong to finished turns.
  let lastUserMessageEntryIndex = -1;
  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries[index];
    if (entry?.kind === "message" && entry.message.role === "user") {
      lastUserMessageEntryIndex = index;
      break;
    }
  }
  const isolationOptions = { settingsExpandMcpToolCalls: input.expandMcpToolCalls };

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      // Computer and preview runs become one session card, whatever the MCP expand setting.
      const automationSurface = classifyAutomationEntry(timelineEntry.entry);
      const shouldIsolateEntry =
        !automationSurface &&
        shouldRenderWorkEntryAsStandaloneRow(timelineEntry.entry, isolationOptions);
      const mcpGroup =
        !automationSurface && isMcpCardWorkEntry(timelineEntry.entry, isolationOptions);
      let cursor = index + 1;
      if (mcpGroup) {
        // Back-to-back MCP calls of the same turn share one card. Capped, so a long run
        // splits into several cards and the list still virtualizes it.
        while (cursor < timelineEntries.length && groupedEntries.length < MCP_CARD_MAX_CALLS) {
          const nextEntry = timelineEntries[cursor];
          if (
            nextEntry?.kind !== "work" ||
            classifyAutomationEntry(nextEntry.entry) ||
            !isMcpCardWorkEntry(nextEntry.entry, isolationOptions) ||
            nextEntry.entry.turnId !== timelineEntry.entry.turnId
          ) {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
      } else if (automationSurface) {
        const end = automationRunEnd(timelineEntries, index, (candidate) =>
          candidate.kind === "work" ? candidate.entry : undefined,
        );
        for (; cursor < end; cursor += 1) {
          const nextEntry = timelineEntries[cursor];
          if (nextEntry?.kind === "work") groupedEntries.push(nextEntry.entry);
        }
      } else if (!shouldIsolateEntry) {
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          if (
            classifyAutomationEntry(nextEntry.entry) ||
            shouldRenderWorkEntryAsStandaloneRow(nextEntry.entry, isolationOptions)
          ) {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
      }
      // A steer leaves a running subagent working, so its group stays open until it ends.
      const isPriorTurn =
        index < lastUserMessageEntryIndex &&
        !groupedEntries.some((entry) => entry.subagentType && entry.status === "inProgress");
      // Only the working turn's calls can still be running; elsewhere an in-progress
      // snapshot is a completion that never arrived.
      const automationActive =
        automationSurface !== undefined && input.isWorking && index > lastUserMessageEntryIndex;
      nextRows.push(
        reuse(
          timelineEntry.id,
          ["work", isPriorTurn, automationSurface, automationActive, mcpGroup, ...groupedEntries],
          () => ({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries,
            isPriorTurn,
            ...(automationSurface ? { automationSurface, automationActive } : {}),
            ...(mcpGroup ? { mcpGroup } : {}),
            workSummary: automationSurface
              ? summarizeAutomationRun(automationSurface, groupedEntries, automationActive)
              : summarizeWorkGroup(groupedEntries),
          }),
        ),
      );
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push(
        reuse(timelineEntry.id, ["proposed-plan", timelineEntry.proposedPlan], () => ({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        })),
      );
      continue;
    }

    if (timelineEntry.kind === "command") {
      nextRows.push(
        reuse(
          timelineEntry.id,
          ["command", timelineEntry.commandExecution, timelineEntry.nestedDiagnostics],
          () => ({
            kind: "command",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            commandExecution: timelineEntry.commandExecution,
            ...(timelineEntry.nestedDiagnostics
              ? { nestedDiagnostics: timelineEntry.nestedDiagnostics }
              : {}),
          }),
        ),
      );
      continue;
    }

    const isLatestCompletion =
      timelineEntry.message.role === "assistant" &&
      input.completionDividerBeforeEntryId === timelineEntry.id;
    const message = timelineEntry.message;
    const turnId = message.turnId;
    const turnSummary = turnId ? input.turnDiffSummaryByTurnId?.get(turnId) : undefined;
    const completionStartedAt =
      turnSummary?.startedAt ??
      (turnId ? startByTurn.get(turnId) : undefined) ??
      promptStartByMessageId.get(message.id);
    const completionCompletedAt = turnSummary?.completedAt ?? message.completedAt;
    const isHistoricalCompletion =
      message.role === "assistant" &&
      !message.streaming &&
      turnId != null &&
      lastAssistantByTurn.get(turnId) === timelineEntry.id &&
      (turnSummary != null ||
        (!input.isWorking && message.completedAt != null) ||
        (lastUserAt != null && message.createdAt < lastUserAt));
    const elapsed =
      completionStartedAt && completionCompletedAt
        ? formatElapsed(completionStartedAt, completionCompletedAt)
        : null;
    const showCompletionDivider = isLatestCompletion || (isHistoricalCompletion && elapsed != null);
    const completionSummary = showCompletionDivider
      ? elapsed != null
        ? `Worked for ${elapsed}`
        : input.completionSummary
      : null;
    const durationStart =
      isHistoricalCompletion || isLatestCompletion
        ? completionStartedAt
        : promptStartByMessageId.has(message.id)
          ? durationStartByMessageId.get(message.id)
          : undefined;
    nextRows.push(
      reuse(
        timelineEntry.id,
        [
          "message",
          timelineEntry.message,
          timelineEntry.userInput,
          durationStart,
          showCompletionDivider,
          completionSummary,
          completionStartedAt,
          completionCompletedAt,
        ],
        () => ({
          kind: "message",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          message: timelineEntry.message,
          ...(timelineEntry.userInput ? { userInput: timelineEntry.userInput } : {}),
          durationStart,
          showCompletionDivider,
          completionSummary,
          ...(elapsed != null && completionStartedAt ? { completionStartedAt } : {}),
          ...(elapsed != null && completionCompletedAt ? { completionCompletedAt } : {}),
        }),
      ),
    );
  }

  if (input.isWorking) {
    const activity = workingActivityLabel(nextRows, input.liveActivity);
    const thought =
      input.liveActivity?.kind === "tool" ? (input.liveActivity.thought ?? null) : null;
    nextRows.push(
      reuse(
        "working-indicator-row",
        ["working", input.activeTurnStartedAt, activity, thought],
        () => ({
          kind: "working",
          id: "working-indicator-row",
          createdAt: input.activeTurnStartedAt,
          activity,
          thought,
        }),
      ),
    );
  }

  // A tool row's bottom gap depends on the row after it, so set it on the row object itself:
  // LegendList then re-renders the earlier row when a tool row lands below it. The adjusted
  // row is cached under its own inputs, so it keeps its identity while the flag holds.
  for (let index = 0; index < nextRows.length; index += 1) {
    const row = nextRows[index]!;
    if (row.kind !== "work" && row.kind !== "command") continue;
    const compactBottom = isToolTimelineRow(nextRows[index + 1]);
    if ((row.compactBottom ?? false) === compactBottom) continue;
    const { compactBottom: _previous, ...rest } = row;
    const adjusted: TimelineRow = compactBottom ? { ...rest, compactBottom } : rest;
    nextRows[index] = adjusted;
    const cached = nextCacheRows.get(row.id);
    if (cached) nextCacheRows.set(row.id, { inputs: cached.inputs, row: adjusted });
  }

  cache.rows = nextCacheRows;
  if (cache.result && sameRowInputs(cache.result, nextRows)) return cache.result;
  cache.result = nextRows;
  return nextRows;
}

export interface TimelineRowExternalsInputs {
  threadId: ThreadId | null;
  expandedWorkGroups: Readonly<Record<string, number>>;
  workGroupCollapseOverrides: Readonly<Record<string, boolean>>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  chatDiffContext: ChatDiffContext;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  revertPopover: { messageId: MessageId; presetRestoreFiles?: boolean } | null;
  revertImpact: TimelineRevertImpact | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  cacheMissByAssistantMessageId: ReadonlyMap<MessageId, TurnCacheSummary>;
  changedFilesPresentationOverrides: Readonly<Record<string, ChangedFilesPresentation>>;
  newestTurnDiffId: TurnId | null;
  expandedCommandExecutions: Readonly<Record<string, boolean>>;
  ribbonActive: boolean;
}

export interface TimelineRowExternalsEntry {
  /** Covers exactly the external inputs the row reads. */
  readonly version: string;
  readonly externals: TimelineRowExternals;
}

function describeTimelineRowExternals(
  row: TimelineRow,
  inputs: TimelineRowExternalsInputs,
  /** The row comes after the thread's last user message. */
  inLatestTurn: boolean,
): { version: string; build: () => TimelineRowExternals } {
  switch (row.kind) {
    case "work": {
      const expandedCount = inputs.expandedWorkGroups[row.id] ?? WORK_LOG_PAGE_SIZE;
      const collapseOverride = inputs.workGroupCollapseOverrides[row.id];
      const { chatDiffContext } = inputs;
      const entryVersions = row.groupedEntries.map((entry) => {
        const turnSummary = entry.turnId
          ? inputs.turnDiffSummaryByTurnId.get(entry.turnId)
          : undefined;
        const inferredCheckpointTurnCount = entry.turnId
          ? (chatDiffContext.inferredCheckpointTurnCountByTurnId[entry.turnId] ?? "")
          : "";
        const fileChangeSummary = entry.fileChangeId
          ? chatDiffContext.fileChangeSummariesById[entry.fileChangeId]
          : undefined;
        return [
          timelineObjectVersion(turnSummary),
          inferredCheckpointTurnCount,
          timelineObjectVersion(fileChangeSummary),
          isInlineFileChangeDiffExpanded(entry.id, chatDiffContext.expandedFileChangeDiffs)
            ? "expanded"
            : "collapsed",
        ].join(",");
      });
      return {
        version: [
          "work",
          expandedCount,
          collapseOverride ?? "",
          chatDiffContext.threadId ?? "",
          chatDiffContext.isGitRepo ? "git" : "no-git",
          ...entryVersions,
        ].join(":"),
        build: () => ({
          kind: "work",
          expandedCount,
          collapseOverride,
          turnDiffSummaryByTurnId: inputs.turnDiffSummaryByTurnId,
          chatDiffContext,
        }),
      };
    }
    case "message": {
      if (row.message.role === "user") {
        const canRevert = inputs.revertTurnCountByUserMessageId.has(row.message.id);
        const popover =
          inputs.revertPopover?.messageId === row.message.id ? inputs.revertPopover : null;
        const revertImpact = popover ? inputs.revertImpact : null;
        const presetRestoreFiles = popover?.presetRestoreFiles;
        return {
          version: [
            "user",
            canRevert ? "revert" : "no-revert",
            popover ? "open" : "closed",
            timelineObjectVersion(revertImpact),
            presetRestoreFiles ?? "",
          ].join(":"),
          build: () => ({
            kind: "user-message",
            canRevert,
            popoverOpen: popover !== null,
            revertImpact,
            presetRestoreFiles,
          }),
        };
      }
      if (row.message.role === "assistant") {
        const turnSummary = inputs.turnDiffSummaryByAssistantMessageId.get(row.message.id);
        const presentationOverride = turnSummary
          ? inputs.changedFilesPresentationOverrides[
              `${inputs.threadId ?? "unknown"}:${turnSummary.turnId}`
            ]
          : undefined;
        const isNewest =
          turnSummary !== undefined && turnSummary.turnId === inputs.newestTurnDiffId;
        const cacheMiss = inputs.cacheMissByAssistantMessageId.get(row.message.id);
        return {
          version: [
            "assistant",
            timelineObjectVersion(turnSummary),
            presentationOverride ?? "",
            isNewest ? "newest" : "older",
            inLatestTurn ? "latest-turn" : "earlier-turn",
            timelineObjectVersion(cacheMiss),
          ].join(":"),
          build: () => ({
            kind: "assistant-message",
            turnSummary,
            presentationOverride,
            isNewest,
            inLatestTurn,
            cacheMiss,
          }),
        };
      }
      return { version: "static", build: () => ({ kind: "static" }) };
    }
    case "command": {
      const expanded = inputs.expandedCommandExecutions[row.commandExecution.id] ?? false;
      return {
        version: `command:${expanded ? "expanded" : "collapsed"}`,
        build: () => ({ kind: "command", expanded }),
      };
    }
    case "working":
      return {
        version: `working:${inputs.ribbonActive ? "ribbon" : "label"}`,
        build: () => ({ kind: "working", ribbonActive: inputs.ribbonActive }),
      };
    case "proposed-plan":
      return { version: "static", build: () => ({ kind: "static" }) };
  }
}

/** The rows and inputs a previous externals map was built from. */
export interface TimelineRowExternalsBasis {
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly inputs: TimelineRowExternalsInputs;
}

function sameTimelineRowExternalsInputs(
  left: TimelineRowExternalsInputs,
  right: TimelineRowExternalsInputs,
): boolean {
  const keys = Object.keys(right) as Array<keyof TimelineRowExternalsInputs>;
  return (
    keys.length === Object.keys(left).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}

// Message externals read a row's id and role, never its text, so a row whose
// message object a streaming delta replaced keeps every entry it had.
function timelineRowsDifferOnlyInMessageContent(
  previous: ReadonlyArray<TimelineRow>,
  rows: ReadonlyArray<TimelineRow>,
): boolean {
  if (previous === rows) return true;
  if (previous.length !== rows.length) return false;
  for (const [index, row] of rows.entries()) {
    const before = previous[index]!;
    if (before === row) continue;
    if (
      before.kind !== "message" ||
      row.kind !== "message" ||
      before.id !== row.id ||
      before.message.role !== row.message.role
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Externals per row id, reusing the previous entry while its version holds.
 * With the `basis` the previous map was built from, a text-only streaming
 * update returns that map without describing any row: the revert and
 * checkpoint lookups only run when the timeline's structure or inputs change.
 */
export function buildTimelineRowExternals(
  rows: ReadonlyArray<TimelineRow>,
  inputs: TimelineRowExternalsInputs,
  previous: ReadonlyMap<string, TimelineRowExternalsEntry>,
  basis?: TimelineRowExternalsBasis,
): ReadonlyMap<string, TimelineRowExternalsEntry> {
  if (
    basis &&
    sameTimelineRowExternalsInputs(basis.inputs, inputs) &&
    timelineRowsDifferOnlyInMessageContent(basis.rows, rows)
  ) {
    return previous;
  }
  const next = new Map<string, TimelineRowExternalsEntry>();
  let changed = rows.length !== previous.size;
  // The latest turn starts after the last user message. Its code blocks stay
  // open: an agent's text, tool call, text sequence must not fold a block the
  // reader may still be reading.
  let latestTurnStart = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "message" && row.message.role === "user") {
      latestTurnStart = index;
      break;
    }
  }
  for (const [index, row] of rows.entries()) {
    const described = describeTimelineRowExternals(row, inputs, index > latestTurnStart);
    const { version } = described;
    const cached = previous.get(row.id);
    const entry =
      cached && cached.version === version ? cached : { version, externals: described.build() };
    if (entry !== cached) changed = true;
    next.set(row.id, entry);
  }
  // Same map while every row keeps its entry, so LegendList's `extraData`
  // only changes when some row's external inputs did.
  return changed ? next : previous;
}
