import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ThreadId,
  type MessageId,
  type TurnId,
  type UserMessageSkillCall,
  type OrchestrationFileChangeSummary,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import type { deriveTimelineEntries, LiveWorkActivity } from "../session-logic";
import type { TurnDiffSummary } from "../types";
import { setNowTickerClockForTests } from "../lib/nowTicker";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { ComposerDock } from "../components/chat/composer/ComposerDock";
import type { ImageAttachmentActionItem } from "../components/chat/imageAttachmentActions";
import { WORK_LOG_PAGE_SIZE } from "../components/chat/workLogConstants";
import { ThreadFindContext } from "../components/chat/threadFindContext";
import {
  useTimelineNavigation,
  type TimelineNavigateOptions,
  type TimelineNavigationStatus,
} from "../components/chat/useTimelineNavigation";
/** Wait for LegendList's asynchronous initial measurements and end positioning. */
export async function waitForTimelineLayout(getNode: () => HTMLElement | null): Promise<void> {
  let stableFrames = 0;
  let previous = "";
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const node = getNode();
    const current = node ? `${node.scrollTop}:${node.scrollHeight}:${node.clientHeight}` : "";
    stableFrames = current !== "" && current === previous ? stableFrames + 1 : 0;
    if (stableFrames >= 6) return;
    previous = current;
  }
  throw new Error("Timeline layout did not settle");
}

export type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
const INLINE_DIFF_THREAD_ID = ThreadId.makeUnsafe("thread-inline-browser");
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
}
export function makeUserEntry(
  id: string,
  text: string,
  offsetSeconds: number,
  options: {
    skillCall?: UserMessageSkillCall;
    attachments?: Array<{
      type: "image";
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      previewUrl: string;
    }>;
  } = {},
): TimelineEntry {
  const createdAt = new Date(
    Date.parse("2026-03-04T12:00:00.000Z") + offsetSeconds * 1000,
  ).toISOString();
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: id as MessageId,
      role: "user",
      text,
      ...(options.skillCall !== undefined ? { skillCall: options.skillCall } : {}),
      createdAt,
      completedAt: createdAt,
      streaming: false,
      attachments: options.attachments ?? [],
      reasoningText: null,
    },
  } as unknown as TimelineEntry;
}

export function makeAssistantEntry(id: string, text: string, offsetSeconds: number): TimelineEntry {
  const createdAt = new Date(
    Date.parse("2026-03-04T12:00:00.000Z") + offsetSeconds * 1000,
  ).toISOString();
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: id as MessageId,
      role: "assistant",
      text,
      createdAt,
      completedAt: createdAt,
      streaming: false,
      attachments: [],
      reasoningText: null,
    },
  } as unknown as TimelineEntry;
}

export interface HarnessProps {
  threadId?: ThreadId;
  initialEntries: TimelineEntry[];
  onIsAtEndChangeSpy: (value: boolean) => void;
  onListRefChange?: (ref: LegendListRef | null) => void;
  headerContent?: React.ReactNode;
  initialHeight?: number;
  initialIsWorking?: boolean;
  initialActiveTurnStartedAt?: string | null;
  initialLiveActivity?: LiveWorkActivity;
  initialExpandedCommandExecutions?: Record<string, boolean>;
  queryClient?: QueryClient;
  turnDiffSummaryByTurnId?: Map<TurnId, TurnDiffSummary>;
  workspaceRoot?: string;
  chatDiffContextOverrides?: Partial<{
    threadId: ThreadId | null;
    isGitRepo: boolean;
    inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
    expandedFileChangeDiffs: Record<string, boolean>;
    fileChangeSummariesById: Record<string, OrchestrationFileChangeSummary>;
  }>;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onImageActionMenu?: (item: ImageAttachmentActionItem, position: { x: number; y: number }) => void;
  usesCustomImageContextMenu?: boolean;
  revertTurnCountByUserMessageId?: Map<MessageId, number>;
  onRevertUserMessage?: (
    messageId: MessageId,
    restoreFiles?: boolean,
    expectedLatestMessageId?: MessageId | null,
  ) => void;
  canRestoreFiles?: boolean;
  revertDisabledReason?: string | null;
  pendingRevert?: { targetMessageId: MessageId; label: string } | null;
  revertReopenRequest?: { messageId: MessageId; restoreFiles: boolean; nonce: number } | null;
  onRevertReopenHandled?: (nonce: number) => void;
  latestMessageId?: MessageId | null;
  initialNowIso?: string;
  onWorkingRibbonFocusLost?: () => void;
  onQuoteAssistantMessage?: (messageId: MessageId, text: string) => void;
  /**
   * Wires the real navigation owner the way ChatView does: rail, minimap and
   * popover jumps, a header host for "Conversation navigation", and find
   * placement. `loadAround` stands in for the history load.
   */
  navigation?: {
    loadAround: (
      entryId: string,
      anchorKind: "message" | "activity",
      signal: AbortSignal,
    ) => Promise<void>;
    onOpenThreadFind?: () => void;
  };
}

export type TimelineHarnessFind = {
  entryId: string;
  query: string;
  occurrence: number;
  requestId?: number | null;
} | null;

export interface TimelineHarnessApi {
  setEntries: (entries: TimelineEntry[]) => void;
  setHeaderContent: (content: React.ReactNode) => void;
  setHeight: (height: number) => void;
  /** Height of the content inside the harness's real composer dock. */
  setDockHeight: (height: number) => void;
  /** Remounts the timeline the way ChatView does on a thread switch. */
  setThreadId: (threadId: ThreadId) => void;
  setTimelineState: (nextState: {
    entries?: TimelineEntry[];
    isWorking?: boolean;
    activeTurnStartedAt?: string | null;
    nowIso?: string;
    liveActivity?: LiveWorkActivity;
  }) => void;
  /** Mirrors ChatView's send-follow: appends entries and requests a tail follow in one commit. */
  followNewTurn: (entries: TimelineEntry[]) => void;
  /** The active thread-find match, as ChatView provides it. */
  setFind: (find: TimelineHarnessFind) => void;
  /** Navigation mode only: a jump through the navigation owner. */
  navigate: (entryId: string, options?: TimelineNavigateOptions) => number;
  /** Navigation mode only: selects a find match and places it, as ChatView's find bar does. */
  navigateToFind: (match: { entryId: string; query: string; occurrence: number }) => void;
  navigationStatus: () => TimelineNavigationStatus;
  retryNavigation: () => void;
  /** Cancels request `id` only if it is still pending (a closed find's jump). */
  cancelNavigationRequest: (id: number) => void;
  /** Mirrors ChatView's Jump to latest. */
  jumpToLatest: () => void;
}

export function TimelineHarness(
  props: HarnessProps & {
    // Parent drives the entry list via this setter so the test can push
    // additions and simulate 0 → >0 transitions.
    setApi?: (api: TimelineHarnessApi) => void;
  },
) {
  const [entries, setEntries] = useState<TimelineEntry[]>(props.initialEntries);
  const [height, setHeight] = useState(props.initialHeight ?? 400);
  const [isWorking, setIsWorking] = useState(props.initialIsWorking ?? false);
  const [activeTurnStartedAt, setActiveTurnStartedAt] = useState<string | null>(
    props.initialActiveTurnStartedAt === undefined
      ? "2026-03-04T12:00:00.000Z"
      : props.initialActiveTurnStartedAt,
  );
  const [nowIso, setNowIso] = useState(() => {
    const initial = props.initialNowIso ?? "2026-03-04T12:05:00.000Z";
    // Live clocks read the shared ticker; pin it so labels stay deterministic.
    setNowTickerClockForTests(() => Date.parse(initial));
    return initial;
  });
  useLayoutEffect(() => {
    setNowTickerClockForTests(() => Date.parse(nowIso));
  }, [nowIso]);
  useLayoutEffect(() => () => setNowTickerClockForTests(null), []);
  const [liveActivity, setLiveActivity] = useState<LiveWorkActivity>(
    props.initialLiveActivity ?? null,
  );
  const [dockHeight, setDockHeight] = useState(0);
  const [threadId, setThreadId] = useState<ThreadId | undefined>(props.threadId);
  const [headerContent, setHeaderContent] = useState<React.ReactNode>(props.headerContent ?? null);
  const [expandedCommandExecutions, setExpandedCommandExecutions] = useState<
    Record<string, boolean>
  >(props.initialExpandedCommandExecutions ?? {});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, number>>({});
  const [workGroupCollapseOverrides, setWorkGroupCollapseOverrides] = useState<
    Record<string, boolean>
  >({});
  const [expandedFileChangeDiffs, setExpandedFileChangeDiffs] = useState<Record<string, boolean>>(
    {},
  );
  const [followNextTailNonce, setFollowNextTailNonce] = useState(0);
  const [find, setFind] = useState<TimelineHarnessFind>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const queryClientRef = useRef<QueryClient>(props.queryClient ?? makeQueryClient());
  // Expose the list ref out through the callback so tests can observe the
  // real LegendList ref the component received.
  useLayoutEffect(() => {
    props.onListRefChange?.(listRef.current);
  });
  const entryRowIndexMapRef = useRef<ReadonlyMap<string, number> | null>(null);
  const leaveEndRef = useRef<(() => void) | null>(null);
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(null);
  const navigation = useTimelineNavigation({
    threadId: threadId ?? null,
    listRef,
    entryRowIndexMapRef,
    loadAround: (entryId, anchorKind, signal) =>
      props.navigation?.loadAround(entryId, anchorKind, signal) ?? Promise.resolve(),
    onLeaveEnd: () => {
      leaveEndRef.current?.();
      props.onIsAtEndChangeSpy(false);
    },
    followNextTailNonce,
  });
  const navigationStatusRef = useRef(navigation.status);
  navigationStatusRef.current = navigation.status;
  const navigationProps = props.navigation
    ? {
        onNavigateToEntry: (entryId: string, position: number) => {
          setFind(null);
          navigation.navigate(entryId, { position });
        },
        onEntryRowIndexMapCommit: navigation.handleRowMapCommit,
        navigationHost,
        onOpenThreadFind: props.navigation.onOpenThreadFind,
        entryRowIndexMapRef,
        leaveEndRef,
      }
    : {};

  if (props.setApi) {
    props.setApi({
      setEntries,
      setHeaderContent,
      setHeight,
      setDockHeight,
      setThreadId,
      setTimelineState: (nextState) => {
        if (nextState.entries !== undefined) setEntries(nextState.entries);
        if (nextState.isWorking !== undefined) setIsWorking(nextState.isWorking);
        if (nextState.nowIso !== undefined) setNowIso(nextState.nowIso);
        if (nextState.liveActivity !== undefined) setLiveActivity(nextState.liveActivity);
        if (Object.hasOwn(nextState, "activeTurnStartedAt")) {
          setActiveTurnStartedAt(nextState.activeTurnStartedAt ?? null);
        }
      },
      followNewTurn: (nextEntries) => {
        setEntries(nextEntries);
        setFollowNextTailNonce((nonce) => nonce + 1);
      },
      setFind,
      navigate: (entryId, options) => navigation.navigate(entryId, options),
      navigateToFind: (match) => {
        const requestId = navigation.navigate(match.entryId, { position: 0.3, placeRange: true });
        setFind({ ...match, requestId });
      },
      navigationStatus: () => navigationStatusRef.current,
      retryNavigation: () => {
        // Mirrors ChatView: a retried find request keeps ownership of the match.
        const retried = navigation.retry();
        if (!retried) return;
        setFind((current) =>
          current?.requestId === retried.previousId
            ? { ...current, requestId: retried.id }
            : current,
        );
      },
      cancelNavigationRequest: (id) => navigation.cancelRequest(id),
      jumpToLatest: () => {
        navigation.cancel();
        setFind(null);
        void listRef.current?.scrollToEnd?.({ animated: false });
      },
    });
  }

  return (
    <div
      data-composer-dock-host
      style={{ height, display: "flex", flexDirection: "column", position: "relative" }}
    >
      {props.navigation ? (
        <div data-testid="harness-navigation-host" ref={setNavigationHost} />
      ) : null}
      <QueryClientProvider client={queryClientRef.current}>
        <ThreadFindContext
          value={find ? { ...find, onSelectedRange: navigation.handleSelectedRange } : null}
        >
          <MessagesTimeline
            {...navigationProps}
            key={threadId}
            {...(threadId ? { threadId } : {})}
            {...(props.onWorkingRibbonFocusLost
              ? { onWorkingRibbonFocusLost: props.onWorkingRibbonFocusLost }
              : {})}
            {...(props.onQuoteAssistantMessage
              ? { onQuoteAssistantMessage: props.onQuoteAssistantMessage }
              : {})}
            hasMessages={entries.length > 0}
            isWorking={isWorking}
            activeTurnStartedAt={activeTurnStartedAt}
            liveActivity={liveActivity}
            listRef={listRef}
            followNextTailNonce={followNextTailNonce}
            onIsAtEndChange={props.onIsAtEndChangeSpy}
            timelineEntries={entries}
            completionDividerBeforeEntryId={null}
            completionSummary={null}
            turnDiffSummaryByAssistantMessageId={new Map()}
            turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId ?? new Map()}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={(groupId, paginatedEntryCount) => {
              setExpandedWorkGroups((current) => {
                const revealedEntries = current[groupId] ?? WORK_LOG_PAGE_SIZE;
                return {
                  ...current,
                  [groupId]:
                    revealedEntries >= paginatedEntryCount
                      ? WORK_LOG_PAGE_SIZE
                      : Math.min(paginatedEntryCount, revealedEntries + WORK_LOG_PAGE_SIZE),
                };
              });
            }}
            workGroupCollapseOverrides={workGroupCollapseOverrides}
            onSetWorkGroupExpanded={(groupId, expanded) => {
              setWorkGroupCollapseOverrides((current) => ({ ...current, [groupId]: expanded }));
            }}
            onOpenTurnDiff={props.onOpenTurnDiff ?? (() => {})}
            revertTurnCountByUserMessageId={props.revertTurnCountByUserMessageId ?? new Map()}
            onRevertUserMessage={props.onRevertUserMessage ?? (() => {})}
            canRestoreFiles={props.canRestoreFiles}
            isRevertingCheckpoint={false}
            revertDisabledReason={props.revertDisabledReason ?? null}
            pendingRevert={props.pendingRevert ?? null}
            revertReopenRequest={props.revertReopenRequest ?? null}
            onRevertReopenHandled={props.onRevertReopenHandled}
            latestMessageId={props.latestMessageId ?? null}
            onImageExpand={() => {}}
            onImageActionMenu={props.onImageActionMenu}
            usesCustomImageContextMenu={props.usesCustomImageContextMenu}
            markdownCwd={undefined}
            resolvedTheme="light"
            timestampFormat="locale"
            workspaceRoot={props.workspaceRoot}
            expandedCommandExecutions={expandedCommandExecutions}
            onToggleCommandExecution={(commandExecutionId) => {
              setExpandedCommandExecutions((current) => ({
                ...current,
                [commandExecutionId]: !(current[commandExecutionId] ?? false),
              }));
            }}
            allDirectoriesExpanded={false}
            onToggleAllDirectories={() => {}}
            listHeaderContent={headerContent}
            chatDiffContext={{
              threadId: INLINE_DIFF_THREAD_ID,
              isGitRepo: true,
              inferredCheckpointTurnCountByTurnId: {},
              expandedFileChangeDiffs,
              fileChangeSummariesById: {},
              onToggleFileChangeDiff: (workEntryId) => {
                setExpandedFileChangeDiffs((current) => ({
                  ...current,
                  [workEntryId]: !(current[workEntryId] ?? true),
                }));
              },
              onOpenFileChangeDiff: () => {},
              ...props.chatDiffContextOverrides,
            }}
          />
        </ThreadFindContext>
      </QueryClientProvider>
      <ComposerDock>
        <div data-testid="harness-dock-content" style={{ height: dockHeight }} />
      </ComposerDock>
    </div>
  );
}
