import { McpAppFrame } from "./McpAppFrame";
import { ThreadFindContext } from "./threadFindContext";
import { highlightThreadFind } from "./threadFindHighlights";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { recordTimelineRowRender } from "../../lib/performanceCounters";
import { messageTextRevision, messageReasoningContent } from "../../lib/streamingTextRevision";
import { computerToolHeading } from "@t3tools/shared/computerAction";
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
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ImageIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MessageSquarePlusIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  ZapIcon,
} from "lucide-react";
import { McpIcon, type Icon } from "../Icons";
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
import {
  buildTimelineEntryRowIndexMap,
  computeMessageDurationStart,
  deriveCodexCollaborationResponseRows,
  deriveTimelineTurnRailItems,
  findNearestMinimapMarkerIndex,
  formatWorkingLabel,
  isFileChangeWorkEntry,
  isFileReadWorkEntry,
  isSearchWorkEntry,
  normalizeCompactToolLabel,
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
} from "./MessagesTimeline.logic";
import { TimelineTurnRail } from "./TimelineTurnRail";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import { WorkingRibbon, type WorkingRibbonReleaseReason } from "./WorkingRibbon";
import { useNowIso } from "../../lib/nowTicker";
import type { RibbonPoint } from "./WorkingRibbon.logic";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { SkillInlineChip } from "./SkillInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
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
import { buildCollapsedUserMessageText, shouldCollapseUserMessage } from "./userMessageCollapse";
import { ReasoningSection } from "./ReasoningSection";
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

const LEGEND_LIST_IS_AT_END_THRESHOLD = 0.1;

const EMPTY_WORK_GROUP_COLLAPSE_OVERRIDES: Readonly<Record<string, boolean>> = {};

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
  hasOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  hasHistoryLoadError?: boolean;
  onLoadOlderHistory?: ((signal: AbortSignal) => Promise<void>) | undefined;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
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
  revertTurnCountByUserMessageId: Map<MessageId, number>;
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
  hasOlderHistory = false,
  isLoadingOlderHistory = false,
  hasHistoryLoadError = false,
  onLoadOlderHistory,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  turnDiffSummaryByTurnId,
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
  const newestTurnDiffId = useMemo(
    () =>
      [...turnDiffSummaryByAssistantMessageId.values()].toSorted((left, right) =>
        right.completedAt.localeCompare(left.completedAt),
      )[0]?.turnId ?? null,
    [turnDiffSummaryByAssistantMessageId],
  );

  useEffect(() => {
    if (!initialScrollAtEndEnabled) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setInitialScrollAtEndEnabled(false);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [initialScrollAtEndEnabled]);

  const rowCacheRef = useRef<TimelineRowCache | null>(null);
  rowCacheRef.current ??= createTimelineRowCache();
  const rowCache = rowCacheRef.current;
  const rows = useMemo(
    () =>
      buildTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        completionSummary,
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
    ],
  );

  const rowCount = rows.length;
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
  useLayoutEffect(() => {
    resolvedEntryRowIndexMapRef.current = entryRowIndexMap;
    return () => {
      if (resolvedEntryRowIndexMapRef.current === entryRowIndexMap) {
        resolvedEntryRowIndexMapRef.current = null;
      }
    };
  }, [entryRowIndexMap, resolvedEntryRowIndexMapRef]);
  const [activeMinimapRowIndex, setActiveMinimapRowIndex] = useState(0);
  const pendingViewableRowIndexRef = useRef(0);
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
      if (firstVisibleIndex <= 3) requestOlderHistory();
      pendingViewableRowIndexRef.current = firstVisibleIndex;
      if (viewabilityFrameRef.current !== 0) return;
      viewabilityFrameRef.current = window.requestAnimationFrame(() => {
        viewabilityFrameRef.current = 0;
        setActiveMinimapRowIndex(pendingViewableRowIndexRef.current);
      });
    },
    [requestOlderHistory],
  );
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
  const turnRailRowIndices = useMemo(
    () => turnRailItems.map((item) => item.rowIndex),
    [turnRailItems],
  );
  const turnRailActiveTickIndex = resolveActiveTurnRailIndex(
    turnRailRowIndices,
    activeMinimapRowIndex,
  );
  const [turnRailHasPersistentGutter, setTurnRailHasPersistentGutter] = useState(false);
  const [turnRailHitStripWidth, setTurnRailHitStripWidth] = useState(0);

  // Upstream fix 33dadb5a:
  // once a brand-new thread receives its first message, LegendList's
  // `initialScrollAtEnd` has already latched. Keep tracking the tail signature
  // so we can explicitly pin again whenever the rendered tail advances while
  // the user was already following the end of the list.
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
    const shouldAutoFollow = followRequested || (didAdvanceTail && isAtEndRef.current);
    if (!shouldAutoFollow) {
      return;
    }

    let frame = 0;
    let cancelled = false;
    const scrollToEndWhenReady = () => {
      if (cancelled) {
        return;
      }
      const list = listRef.current;
      if (!list) {
        frame = window.requestAnimationFrame(scrollToEndWhenReady);
        return;
      }
      isAtEndRef.current = true;
      // A submitted turn can be thousands of virtual rows away. Jump to its
      // measured tail instead of animating through estimated intermediate rows.
      list.scrollToEnd?.({ animated: !followRequested });
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
    isAtEndRef.current = true;
  }, [followNextTailNonce]);

  const syncIsAtEndFromListState = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      // LegendList's public `isAtEnd` flag can lag behind passive layout
      // changes, but its exposed scroll metrics stay current.
      const distanceFromEnd = state.contentLength - state.scroll - state.scrollLength;
      const isAtEnd =
        state.contentLength < state.scrollLength ||
        distanceFromEnd < state.scrollLength * LEGEND_LIST_IS_AT_END_THRESHOLD;
      isAtEndRef.current = isAtEnd;
      onIsAtEndChange(isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const measureTurnRailGutter = useCallback(() => {
    const node = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement)) return;
    // Measure rendered geometry so scrollbars, responsive padding, and zoom
    // cannot make the hit target overlap the content column.
    const column = node.querySelector<HTMLElement>('[data-timeline-root="true"]');
    if (!column) return;
    const gutterPx = column.getBoundingClientRect().left - node.getBoundingClientRect().left;
    setTurnRailHasPersistentGutter((current) => {
      const next = resolveTimelineTurnRailHasPersistentGutter(gutterPx);
      return current === next ? current : next;
    });
    setTurnRailHitStripWidth((current) => {
      const next = resolveTimelineTurnRailHitStripWidth(gutterPx);
      return current === next ? current : next;
    });
  }, [listRef]);

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
  }, [hasMessages, isWorking, listRef, measureTurnRailGutter, syncIsAtEndFromListState]);

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
  const disclosurePinsEndRef = useRef(false);
  const disclosureSettleFrameRef = useRef<number | null>(null);
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

  const navigateToTimelineRow = useCallback(
    (rowIndex: number, viewPosition: number) => {
      isAtEndRef.current = false;
      onIsAtEndChange(false);
      void listRef.current?.scrollToIndex({
        index: rowIndex,
        animated: false,
        viewPosition,
      });
    },
    [listRef, onIsAtEndChange],
  );

  const forwardOverlayWheel = useCallback(
    (event: WheelEvent) => {
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
    navigateToTimelineRow(rowIndex, 0.3);
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
      grabButtonRef,
      actions: rowActions,
    }),
    [
      allDirectoriesExpanded,
      canRestoreFiles,
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
  const committedRowExternalsRef = useRef<ReadonlyMap<string, TimelineRowExternalsEntry>>(
    new Map(),
  );
  const rowExternals = useMemo(
    () =>
      buildTimelineRowExternals(
        rows,
        {
          threadId,
          expandedWorkGroups,
          workGroupCollapseOverrides,
          turnDiffSummaryByTurnId,
          chatDiffContext: rowChatDiffContext,
          revertTurnCountByUserMessageId,
          revertPopover,
          revertImpact,
          turnDiffSummaryByAssistantMessageId,
          changedFilesPresentationOverrides,
          newestTurnDiffId,
          expandedCommandExecutions,
          ribbonActive,
        },
        committedRowExternalsRef.current,
      ),
    [
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
    ],
  );
  useLayoutEffect(() => {
    committedRowExternalsRef.current = rowExternals;
  }, [rowExternals]);
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

  if (!hasMessages && !isWorking) {
    // Render the header slot above the empty-state message so that any
    // ThreadTasksPanel passed in by ChatView still shows on threads that have
    // tasks but no timeline rows yet (e.g. freshly loaded detail before the
    // first message arrives). Without this branch, passing the tasks panel
    // through `listHeaderContent` would silently drop it on empty threads.
    return (
      <div
        className="flex h-full flex-col overflow-y-auto overscroll-y-contain px-3 pb-(--composer-dock-height) sm:px-5"
        data-slot="messages-scroll-container"
      >
        {listHeaderContent ? <div className="pt-3 sm:pt-4">{listHeaderContent}</div> : null}
        <MessagesTimelineEmpty emptyState={emptyState} />
      </div>
    );
  }

  return (
    <TimelineRowContext.Provider value={timelineRowContext}>
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
          maintainScrollAtEnd={{ on: { itemLayout: true, layout: true } }}
          maintainScrollAtEndThreshold={LEGEND_LIST_IS_AT_END_THRESHOLD}
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
          className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
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
            onNavigate={(rowIndex) => navigateToTimelineRow(rowIndex, 0.3)}
            onWheel={forwardOverlayWheel}
          />
        ) : null}
        {turnRailItems.length >= TIMELINE_TURN_RAIL_MIN_ITEMS ? (
          <TimelineTurnRail
            items={turnRailItems}
            hasPersistentGutter={turnRailHasPersistentGutter}
            hitStripWidth={turnRailHitStripWidth}
            activeTickIndex={turnRailActiveTickIndex}
            onSelect={(item) => navigateToTimelineRow(item.rowIndex, 0.1)}
            onWheel={forwardOverlayWheel}
          />
        ) : null}
      </TooltipScrollDismissArea>
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
  testRenderCountProps,
  children,
}: {
  row: TimelineRow;
  testRenderCountProps?: { "data-render-count": number } | undefined;
  children: ReactNode;
}) {
  const find = useContext(ThreadFindContext);
  const element = useRef<HTMLDivElement>(null);
  const active = find?.entryId === row.id;
  useEffect(() => {
    const root = element.current;
    if (!active || !find || !root) return;
    let clear = () => {};
    let frame = 0;
    const refresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          clear();
          clear = highlightThreadFind(root, find.query, find.occurrence);
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
      className="pb-4"
      {...testRenderCountProps}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "message" ? (
        <h2 className="sr-only">
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
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineCommandExecution = Extract<TimelineEntry, { kind: "command" }>["commandExecution"];

function shouldRenderWorkEntryAsStandaloneRow(
  entry: TimelineWorkEntry,
  options: { settingsExpandMcpToolCalls: boolean },
): boolean {
  return (
    !!entry.htmlRender || (entry.itemType === "mcp_tool_call" && options.settingsExpandMcpToolCalls)
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
      workSummary: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      completionSummary: string | null;
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
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      activity: string | null;
      /** The latest thought while a later tool runs. */
      thought: string | null;
    };

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

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

// Live clocks are leaves on the shared 1 Hz ticker so a tick re-renders only
// the text that shows elapsed time, never the timeline or its rows.
function LiveMessageMeta(props: {
  createdAt: string;
  durationStart: string;
  completedAt: string | undefined;
  streaming: boolean;
  timestampFormat: TimestampFormat;
}) {
  const nowIso = useNowIso(props.streaming);
  return formatMessageMeta(
    props.createdAt,
    formatElapsed(props.durationStart, props.streaming ? nowIso : props.completedAt),
    props.timestampFormat,
  );
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

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  skillCall?: UserMessageSkillCall | undefined;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse =
    props.terminalContexts.length === 0 && shouldCollapseUserMessage(props.text);
  const collapsedText = shouldCollapse ? buildCollapsedUserMessageText(props.text) : props.text;
  const canCollapse =
    shouldCollapse &&
    collapsedTextPreservesSkillPrefix({
      text: props.text,
      collapsedText,
      skillCall: props.skillCall,
    });
  if (!canCollapse) {
    return <UserMessageBody {...props} />;
  }

  const displayText = expanded ? props.text : collapsedText;
  return (
    <>
      <UserMessageBody text={displayText} skillCall={props.skillCall} terminalContexts={[]} />
      <button
        type="button"
        className="mt-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={expanded}
        data-scroll-anchor-ignore
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </>
  );
});

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

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  skillCall?: UserMessageSkillCall | undefined;
  terminalContexts: ParsedTerminalContextEntry[];
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
              {textAfterSkillPrefix.slice(cursor, matchIndex)}
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
              {textAfterSkillPrefix.slice(cursor)}
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
        <span key="user-message-terminal-context-inline-text">{textAfterSkillPrefix}</span>,
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
          <span key="user-message-skill-call-rest">{textAfterSkillPrefix}</span>
        ) : null}
      </div>
    );
  }

  return (
    <pre
      className="whitespace-pre-wrap wrap-break-word chat-plaintext leading-relaxed text-foreground"
      {...(testRenderCountProps ?? {})}
    >
      {textAfterSkillPrefix}
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
    | "lineSummary"
    | "readPaths"
    | "requestKind"
    | "searchSummary"
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
  if (workEntry.detail) return workEntry.detail;
  return changedFilesPreview;
}

type TimelineEntryIcon = Icon | LucideIcon;

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

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return McpIcon;
    case "dynamic_tool_call":
      return HammerIcon;
    case "collab_agent_tool_call":
      return BotIcon;
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
            title={displayText}
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

const McpToolCallRow = memo(function McpToolCallRow(props: {
  workEntry: TimelineWorkEntry;
  expandByDefault: boolean;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  timestamp: ReactNode;
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

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = formatMcpToolHeading(workEntry);
  // Hover tooltip gets the fuller "MCP Call - <server>: <tool>" phrasing so a
  // user scanning a dense timeline can confirm what kind of row this is
  // without expanding it. The visible heading stays compact because the
  // "MCP tool call" badge above already labels the kind.
  const hoverTitle = toolWorkEntryHeading(workEntry);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setUserOverrodeOpen(true);
    setOpen(nextOpen);
  }, []);

  return (
    <Collapsible
      className="group rounded-xl border border-border bg-card"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !hasNestedContent && "cursor-default",
        )}
        disabled={!hasNestedContent}
      >
        <span className="mt-0.5 shrink-0 text-faint-foreground">
          {hasNestedContent ? (
            open ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )
          ) : (
            <ChevronRightIcon className="size-4 opacity-0" />
          )}
        </span>
        <span
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center",
            iconConfig.className,
          )}
        >
          <EntryIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-5 items-center rounded-full border border-border bg-muted/50 px-2 text-2xs font-medium text-muted-foreground">
              MCP tool call
            </span>
          </div>
          <p className="mt-1.5 text-ui font-medium text-foreground" title={hoverTitle}>
            {heading}
          </p>
        </div>
        {props.timestamp}
      </CollapsibleTrigger>
      {workEntry.mcpImages && workEntry.mcpImages.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pb-2.5 pl-13" data-testid="mcp-tool-images">
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
          <div className="border-t border-border px-3 py-3">
            <div className="space-y-3">
              {workEntry.mcpInput && (
                <div>
                  <p className="text-2xs font-medium text-muted-foreground">Input</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-2 font-mono text-xs leading-5 text-foreground">
                    {workEntry.mcpInput}
                  </pre>
                </div>
              )}
              {workEntry.mcpResult && (
                <div>
                  <p className="text-2xs font-medium text-muted-foreground">Result</p>
                  <div className="mt-1 max-h-80 overflow-auto rounded-md bg-muted/40 p-2 text-ui text-foreground">
                    <ChatMarkdown
                      text={workEntry.mcpResult}
                      cwd={markdownCwd}
                      isStreaming={false}
                    />
                  </div>
                </div>
              )}
            </div>
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
                <span className={WORK_META_CHIP_CLASS_NAME}>{workEntry.subagentType}</span>
              )}
              {workEntry.subagentModel && (
                <span className={cn(WORK_META_CHIP_CLASS_NAME, "font-mono")}>
                  {workEntry.subagentModel}
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
  // A bordered MCP card spans the full row and shows its time in its own header; a time
  // in the shared right gutter overlapped the card's corner whenever it was wider.
  const mcpCard =
    !workEntry.diagnostic && workEntry.itemType === "mcp_tool_call" && props.expandMcpToolCalls;
  const row =
    workEntry.mcpApp && threadId ? (
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
      <McpToolCallRow
        workEntry={workEntry}
        expandByDefault={props.expandMcpByDefault}
        turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId}
        workspaceRoot={props.workspaceRoot}
        markdownCwd={props.markdownCwd}
        timestamp={timestamp("shrink-0 pt-0.5")}
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
    <div className={cn("group/work-entry relative min-w-0", !mcpCard && "pr-14")}>
      {mcpCard ? null : timestamp("absolute right-1 top-1.5")}
      {row}
      {workEntry.nestedDiagnostics && workEntry.nestedDiagnostics.length > 0 ? (
        <NestedDiagnosticList diagnostics={workEntry.nestedDiagnostics} />
      ) : null}
    </div>
  );
});

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
  return (
    <TimelineRowWrapper row={props.row} testRenderCountProps={testRenderCountProps}>
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
  const standaloneExpandedMcpEntry =
    row.groupedEntries.length === 1 &&
    (row.groupedEntries[0]?.htmlRender || row.groupedEntries[0]?.mcpApp)
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

  const expanded = externals.collapseOverride ?? !(row.isPriorTurn && collapseCompletedWorkLogs);
  const canCollapse = row.isPriorTurn && canSetWorkGroupExpanded;
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
    usesCustomImageContextMenu,
    workspaceRoot,
  } = useTimelineRowContext();
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
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const canRevertAgentWork = externals.canRevert;
  return (
    <div className="group/user-message flex flex-col items-end">
      <div
        className="max-w-[85%] rounded-xl rounded-br-md border border-border bg-secondary px-4 py-2.5"
        data-slot="user-message-bubble"
      >
        {userFiles.map((file) => (
          <AttachmentFileChip key={file.id} file={file} />
        ))}
        {userImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {userImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => {
              const previewUrl = image.previewUrl;
              return (
                <div
                  key={image.id}
                  className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                >
                  {previewUrl ? (
                    <button
                      type="button"
                      className="h-full w-full cursor-zoom-in"
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
                      <img
                        src={previewUrl}
                        alt={image.name}
                        className="h-full max-h-[220px] w-full object-cover"
                        draggable={false}
                      />
                    </button>
                  ) : (
                    <div className="flex min-h-18 items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground">
                      {image.name}
                    </div>
                  )}
                </div>
              );
            })}
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
            <CollapsibleUserMessageBody
              key={row.message.id}
              text={displayedUserMessage.visibleText}
              skillCall={row.message.skillCall}
              terminalContexts={terminalContexts}
            />
          </>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1 pr-1">
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
  const { markdownCwd, showReasoningExpanded, timestampFormat } = useTimelineRowContext();
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const reasoning = messageReasoningContent(row.message);
  const reasoningText = reasoning.text;
  const isStreamingReasoning =
    Boolean(row.message.streaming) && row.message.text.length === 0 && Boolean(reasoningText);
  return (
    <>
      {row.showCompletionDivider && (
        <div className="my-3 flex items-center gap-3" role="separator">
          <span className="h-px flex-1 bg-border" />
          <SectionLabel as="span" className="min-h-0">
            {row.completionSummary ?? "Response"}
          </SectionLabel>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="group/assistant-message min-w-0 px-1 py-0.5">
        {reasoningText ? (
          <ReasoningSection
            reasoningText={reasoningText}
            textRevision={reasoning.revision}
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
          />
        </div>
        <AssistantChangedFiles externals={externals} />
        <div className="mt-1.5 flex min-h-7 items-center justify-between gap-2">
          <p className="text-2xs text-muted-foreground tabular-nums">
            <LiveMessageMeta
              createdAt={row.message.createdAt}
              durationStart={row.durationStart}
              completedAt={row.message.completedAt}
              streaming={row.message.streaming}
              timestampFormat={timestampFormat}
            />
          </p>
          <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/assistant-message:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
            <AssistantMessageActions rawText={row.message.text} />
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
  const { actions, isWorking, threadId, timestampFormat } = useTimelineRowContext();
  return (
    <div className="min-w-0 px-1 py-0.5">
      <CommandTranscriptCard
        threadId={threadId}
        execution={row.commandExecution}
        expanded={externals.expanded}
        timestampFormat={timestampFormat}
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
    sameRowInputs(cache.parameters, parameters)
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
      const shouldIsolateEntry = shouldRenderWorkEntryAsStandaloneRow(
        timelineEntry.entry,
        isolationOptions,
      );
      let cursor = index + 1;
      if (!shouldIsolateEntry) {
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          if (shouldRenderWorkEntryAsStandaloneRow(nextEntry.entry, isolationOptions)) {
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
      nextRows.push(
        reuse(timelineEntry.id, ["work", isPriorTurn, ...groupedEntries], () => ({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
          isPriorTurn,
          workSummary: summarizeWorkGroup(groupedEntries),
        })),
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

    const showCompletionDivider =
      timelineEntry.message.role === "assistant" &&
      input.completionDividerBeforeEntryId === timelineEntry.id;
    const completionSummary = showCompletionDivider ? input.completionSummary : null;
    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;
    nextRows.push(
      reuse(
        timelineEntry.id,
        ["message", timelineEntry.message, durationStart, showCompletionDivider, completionSummary],
        () => ({
          kind: "message",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          message: timelineEntry.message,
          durationStart,
          showCompletionDivider,
          completionSummary,
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
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  revertPopover: { messageId: MessageId; presetRestoreFiles?: boolean } | null;
  revertImpact: TimelineRevertImpact | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
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
        return {
          version: [
            "assistant",
            timelineObjectVersion(turnSummary),
            presentationOverride ?? "",
            isNewest ? "newest" : "older",
          ].join(":"),
          build: () => ({ kind: "assistant-message", turnSummary, presentationOverride, isNewest }),
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

/** Externals per row id, reusing the previous entry while its version holds. */
export function buildTimelineRowExternals(
  rows: ReadonlyArray<TimelineRow>,
  inputs: TimelineRowExternalsInputs,
  previous: ReadonlyMap<string, TimelineRowExternalsEntry>,
): ReadonlyMap<string, TimelineRowExternalsEntry> {
  const next = new Map<string, TimelineRowExternalsEntry>();
  let changed = rows.length !== previous.size;
  for (const row of rows) {
    const { version, build } = describeTimelineRowExternals(row, inputs);
    const cached = previous.get(row.id);
    const entry = cached && cached.version === version ? cached : { version, externals: build() };
    if (entry !== cached) changed = true;
    next.set(row.id, entry);
  }
  // Same map while every row keeps its entry, so LegendList's `extraData`
  // only changes when some row's external inputs did.
  return changed ? next : previous;
}
