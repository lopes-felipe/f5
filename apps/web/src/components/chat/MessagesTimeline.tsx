import {
  type MessageId,
  type OrchestrationFileChangeId,
  type OrchestrationFileChangeSummary,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  ZapIcon,
} from "lucide-react";
import { McpIcon, type Icon } from "../Icons";
import { openInPreferredEditor } from "../../editorPreferences";
import { useFileNavigation } from "../../fileNavigationContext";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { CommandTranscriptCard } from "./CommandTranscriptCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantMessageActions } from "./AssistantMessageActions";
import { computeMessageDurationStart, normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import { cn } from "~/lib/utils";
import { type TimestampFormat, useAppSettings } from "../../appSettings";
import { readNativeApi } from "../../nativeApi";
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
import { ReasoningSection } from "./ReasoningSection";
import { COMPOSER_INLINE_CHIP_CLASS_NAME } from "../composerInlineChip";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { classifyCompactCommand, isGenericCommandTitle } from "@t3tools/shared/commandSummary";
import { InlineExactFileChangeDiff } from "./InlineExactFileChangeDiff";
import { InlineFileChangeDiff } from "./InlineFileChangeDiff";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const LEGEND_LIST_IS_AT_END_THRESHOLD = 0.1;

interface MessagesTimelineProps {
  threadId?: ThreadId | null;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  /**
   * TODO(perf): `nowIso` ticks every second while a turn is in flight, which
   * re-renders the entire timeline through this component. Upstream's
   * react-virtual implementation kept the clock out of the hot path by
   * pushing `nowIso` through a `TimelineRowCtx` / `WorkingTimer` +
   * `LiveMessageMeta` split so only the rows that actually display elapsed
   * time (the working indicator and the in-flight message meta) re-render
   * on each tick. We intentionally kept the simpler prop-drilled shape for
   * the port since LegendList's cell-level reuse already amortizes most of
   * the cost, but if profiling under LegendList shows frame drops during
   * long streaming turns we should port that split.
   */
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
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
}

export interface ChatDiffContext {
  threadId: ThreadId | null;
  isGitRepo: boolean;
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
  inferredCheckpointTurnCountByTurnId: {},
  expandedFileChangeDiffs: {},
  fileChangeSummariesById: {},
  onToggleFileChangeDiff: () => {},
  onOpenFileChangeDiff: () => {},
};

export const MessagesTimeline = memo(function MessagesTimeline({
  threadId = null,
  hasMessages,
  isWorking,
  activeTurnStartedAt,
  listRef,
  onIsAtEndChange,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  turnDiffSummaryByTurnId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
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
}: MessagesTimelineProps) {
  const { settings } = useAppSettings();
  const [initialScrollAtEndEnabled, setInitialScrollAtEndEnabled] = useState(true);
  const isAtEndRef = useRef(true);

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

  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];
    const durationStartByMessageId = computeMessageDurationStart(
      timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    );

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        const shouldIsolateEntry = shouldRenderWorkEntryAsStandaloneRow(timelineEntry.entry, {
          settingsExpandMcpToolCalls: settings.expandMcpToolCalls,
        });
        let cursor = index + 1;
        if (!shouldIsolateEntry) {
          while (cursor < timelineEntries.length) {
            const nextEntry = timelineEntries[cursor];
            if (!nextEntry || nextEntry.kind !== "work") break;
            if (
              shouldRenderWorkEntryAsStandaloneRow(nextEntry.entry, {
                settingsExpandMcpToolCalls: settings.expandMcpToolCalls,
              })
            ) {
              break;
            }
            groupedEntries.push(nextEntry.entry);
            cursor += 1;
          }
        }
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      }

      if (timelineEntry.kind === "command") {
        nextRows.push({
          kind: "command",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          commandExecution: timelineEntry.commandExecution,
        });
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [
    timelineEntries,
    completionDividerBeforeEntryId,
    isWorking,
    activeTurnStartedAt,
    settings.expandMcpToolCalls,
  ]);

  const rowCount = rows.length;
  const lastRowId = rowCount > 0 ? (rows[rowCount - 1]?.id ?? null) : null;

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
    const shouldAutoFollow = didAdvanceTail && isAtEndRef.current;
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
      list.scrollToEnd?.({ animated: true });
      onIsAtEndChange(true);
    };
    frame = window.requestAnimationFrame(scrollToEndWhenReady);

    return () => {
      cancelled = true;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [lastRowId, listRef, onIsAtEndChange, rowCount]);

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
  }, [hasMessages, isWorking, listRef, syncIsAtEndFromListState]);

  const handleScroll = useCallback(() => {
    syncIsAtEndFromListState();
  }, [syncIsAtEndFromListState]);

  const keyExtractor = useCallback((row: TimelineRow) => row.id, []);

  // NOTE: This closure depends on many callbacks/state slices from props (see
  // ChatView's `<MessagesTimeline … />` wiring), so memoizing it via
  // useCallback would require a long dependency list that changes every render
  // anyway. We intentionally leave it unmemoized; see also the `nowIso` TODO
  // on the prop for the same reason.
  const legendListExtraData = useMemo(
    () => [
      settings.expandMcpToolCalls,
      settings.expandMcpToolCallCardsByDefault,
      settings.showReasoningExpanded,
      settings.showFileChangeDiffsInline,
      chatDiffContext,
      expandedWorkGroups,
      expandedCommandExecutions,
      isRevertingCheckpoint,
      resolvedTheme,
      timestampFormat,
      workspaceRoot,
      markdownCwd,
      allDirectoriesExpanded,
      nowIso,
      completionDividerBeforeEntryId,
      completionSummary,
      activeTurnStartedAt,
      revertTurnCountByUserMessageId,
      turnDiffSummaryByAssistantMessageId,
      turnDiffSummaryByTurnId,
    ],
    [
      activeTurnStartedAt,
      allDirectoriesExpanded,
      chatDiffContext,
      completionDividerBeforeEntryId,
      completionSummary,
      expandedCommandExecutions,
      expandedWorkGroups,
      isRevertingCheckpoint,
      markdownCwd,
      nowIso,
      resolvedTheme,
      settings.expandMcpToolCallCardsByDefault,
      settings.expandMcpToolCalls,
      settings.showFileChangeDiffsInline,
      settings.showReasoningExpanded,
      timestampFormat,
      turnDiffSummaryByAssistantMessageId,
      turnDiffSummaryByTurnId,
      revertTurnCountByUserMessageId,
      workspaceRoot,
    ],
  );
  const legendListDataVersion = useMemo(
    () =>
      rows
        .map((row) => {
          switch (row.kind) {
            case "message":
              return [
                row.kind,
                row.id,
                row.createdAt,
                row.showCompletionDivider ? "divider" : "no-divider",
                row.message.streaming ? "streaming" : "stable",
                row.message.text.length,
                row.message.reasoningText?.length ?? 0,
              ].join(":");
            case "work":
              return [
                row.kind,
                row.id,
                row.createdAt,
                ...row.groupedEntries.map((entry) => {
                  const turnDiffSummary = entry.turnId
                    ? turnDiffSummaryByTurnId.get(entry.turnId)
                    : undefined;
                  const checkpointTurnCount = entry.turnId
                    ? (turnDiffSummary?.checkpointTurnCount ??
                      chatDiffContext.inferredCheckpointTurnCountByTurnId[entry.turnId] ??
                      "")
                    : "";
                  const fileChangeSummary = entry.fileChangeId
                    ? chatDiffContext.fileChangeSummariesById[entry.fileChangeId]
                    : undefined;
                  return [
                    entry.id,
                    entry.status ?? "",
                    entry.itemType ?? "",
                    entry.turnId ?? "",
                    checkpointTurnCount,
                    entry.fileChangeId ?? "",
                    fileChangeSummary?.status ?? "",
                    fileChangeSummary?.hasPatch ? "patch" : "no-patch",
                    isInlineFileChangeDiffExpanded(
                      entry.id,
                      chatDiffContext.expandedFileChangeDiffs,
                    )
                      ? "expanded"
                      : "collapsed",
                  ].join(":");
                }),
              ].join("|");
            case "command":
              return [
                row.kind,
                row.id,
                row.createdAt,
                row.commandExecution.status,
                row.commandExecution.completedAt ?? "",
              ].join(":");
            case "proposed-plan":
              return [row.kind, row.id, row.createdAt, row.proposedPlan.updatedAt].join(":");
            case "working":
              return [row.kind, row.id, row.createdAt ?? ""].join(":");
          }
        })
        .join("||"),
    [rows, turnDiffSummaryByTurnId, chatDiffContext],
  );

  const renderRowContent = (row: TimelineRow) => (
    <TimelineRowWrapper row={row}>
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupState = resolveWorkGroupRenderState(
            row.groupedEntries,
            expandedWorkGroups[groupId] ?? false,
          );
          const standaloneExpandedMcpEntry = resolveStandaloneExpandedMcpWorkEntry(
            row.groupedEntries,
            {
              settingsExpandMcpToolCalls: settings.expandMcpToolCalls,
            },
          );

          if (standaloneExpandedMcpEntry) {
            return (
              <div className="min-w-0 px-1 py-0.5">
                <McpToolCallRow
                  workEntry={standaloneExpandedMcpEntry}
                  expandByDefault={settings.expandMcpToolCallCardsByDefault}
                  turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
                  workspaceRoot={workspaceRoot}
                  markdownCwd={markdownCwd}
                />
              </div>
            );
          }

          return (
            <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
              {groupState.showHeader && (
                <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                  <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                    {groupState.groupLabel} ({row.groupedEntries.length})
                  </p>
                  {groupState.hasOverflow && (
                    <button
                      type="button"
                      className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                      onClick={() => onToggleWorkGroup(groupId)}
                    >
                      {groupState.isExpanded ? "Show less" : `Show ${groupState.hiddenCount} more`}
                    </button>
                  )}
                </div>
              )}
              <div className="space-y-0.5">
                {groupState.visibleEntries.map((workEntry) =>
                  workEntry.itemType === "collab_agent_tool_call" ? (
                    <SubagentWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
                      workspaceRoot={workspaceRoot}
                      markdownCwd={markdownCwd}
                    />
                  ) : workEntry.itemType === "mcp_tool_call" && settings.expandMcpToolCalls ? (
                    <McpToolCallRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      expandByDefault={settings.expandMcpToolCallCardsByDefault}
                      turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
                      workspaceRoot={workspaceRoot}
                      markdownCwd={markdownCwd}
                    />
                  ) : (
                    <SimpleWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
                      workspaceRoot={workspaceRoot}
                      resolvedTheme={resolvedTheme}
                      showFileChangeDiffsInline={settings.showFileChangeDiffsInline}
                      chatDiffContext={chatDiffContext}
                      onOpenTurnDiff={onOpenTurnDiff}
                    />
                  ),
                )}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full max-h-[220px] w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
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
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-[10px] text-muted-foreground/30">
                    {formatTimestamp(row.message.createdAt, timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const reasoningText = row.message.reasoningText?.trim();
          const isStreamingReasoning =
            Boolean(row.message.streaming) &&
            row.message.text.length === 0 &&
            Boolean(reasoningText);
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {completionSummary ? `Response • ${completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="group/assistant-message min-w-0 px-1 py-0.5">
                <div className="mb-1 flex justify-end">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant-message:opacity-100 pointer-coarse:opacity-100">
                    <AssistantMessageActions rawText={row.message.text} />
                  </div>
                </div>
                {reasoningText ? (
                  <ReasoningSection
                    reasoningText={reasoningText}
                    defaultExpanded={settings.showReasoningExpanded}
                    isStreaming={isStreamingReasoning}
                    cwd={markdownCwd}
                  />
                ) : null}
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                  const changedFileCountLabel = String(checkpointFiles.length);
                  return (
                    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                          <span>Changed files ({changedFileCountLabel})</span>
                          {hasNonZeroStat(summaryStat) && (
                            <>
                              <span className="mx-1">•</span>
                              <DiffStatLabel
                                additions={summaryStat.additions}
                                deletions={summaryStat.deletions}
                              />
                            </>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => onToggleAllDirectories()}
                          >
                            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                            }
                          >
                            View diff
                          </Button>
                        </div>
                      </div>
                      <ChangedFilesTree
                        key={`changed-files-tree:${turnSummary.turnId}`}
                        turnId={turnSummary.turnId}
                        files={checkpointFiles}
                        allDirectoriesExpanded={allDirectoriesExpanded}
                        resolvedTheme={resolvedTheme}
                        onOpenTurnDiff={onOpenTurnDiff}
                      />
                    </div>
                  );
                })()}
                <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                  {formatMessageMeta(
                    row.message.createdAt,
                    row.message.streaming
                      ? formatElapsed(row.durationStart, nowIso)
                      : formatElapsed(row.durationStart, row.message.completedAt),
                    timestampFormat,
                  )}
                </p>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}

      {row.kind === "command" && (
        <div className="min-w-0 px-1 py-0.5">
          <CommandTranscriptCard
            threadId={threadId}
            execution={row.commandExecution}
            expanded={expandedCommandExecutions[row.commandExecution.id] ?? false}
            nowIso={nowIso}
            timestampFormat={timestampFormat}
            onToggle={() => onToggleCommandExecution(row.commandExecution.id)}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
            <span>
              {row.createdAt
                ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                : "Working..."}
            </span>
          </div>
        </div>
      )}
    </TimelineRowWrapper>
  );

  // Plain function, not memoized: `renderRowContent` depends on every render's
  // current closure (expansion state, callbacks, nowIso, …), so wrapping this
  // in useCallback with a dependency list that changes every render would be
  // dead weight. LegendList handles cell-level reuse itself.
  const renderItem = ({ item }: { item: TimelineRow }) => (
    <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
      {renderRowContent(item)}
    </div>
  );

  if (!hasMessages && !isWorking) {
    // Render the header slot above the empty-state message so that any
    // ThreadTasksPanel passed in by ChatView still shows on threads that have
    // tasks but no timeline rows yet (e.g. freshly loaded detail before the
    // first message arrives). Without this branch, passing the tasks panel
    // through `listHeaderContent` would silently drop it on empty threads.
    return (
      <div
        className="flex h-full flex-col overflow-y-auto overscroll-y-contain px-3 sm:px-5"
        data-slot="messages-scroll-container"
      >
        {listHeaderContent ? <div className="pt-3 sm:pt-4">{listHeaderContent}</div> : null}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground/30">
            Send a message to start the conversation.
          </p>
        </div>
      </div>
    );
  }

  return (
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
      ListFooterComponent={<div className="h-3 sm:h-4" />}
    />
  );
});

// Wraps each row with the DOM attributes that tests and selectors depend on
// (data-timeline-row-id, data-timeline-row-kind, data-message-id, data-message-role).
// Replaces the former `ObservedTimelineRow` — LegendList measures rows
// internally, so the ResizeObserver shim is no longer needed.
const TimelineRowWrapper = memo(function TimelineRowWrapper({
  row,
  children,
}: {
  row: TimelineRow;
  children: ReactNode;
}) {
  return (
    <div
      className="pb-4"
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
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
  return entry.itemType === "mcp_tool_call" && options.settingsExpandMcpToolCalls;
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
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      showCompletionDivider: boolean;
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
    }
  | { kind: "working"; id: string; createdAt: string | null };

interface WorkGroupRenderState {
  groupLabel: string;
  hasOverflow: boolean;
  hiddenCount: number;
  isExpanded: boolean;
  showHeader: boolean;
  visibleEntries: TimelineWorkEntry[];
}

function resolveWorkGroupRenderState(
  groupedEntries: TimelineWorkEntry[],
  isExpanded: boolean,
): WorkGroupRenderState {
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  return {
    groupLabel: onlyToolEntries ? "Tool calls" : "Work log",
    hasOverflow,
    hiddenCount,
    isExpanded,
    showHeader: hasOverflow || !onlyToolEntries,
    visibleEntries,
  };
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
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

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
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
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

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

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {props.text}
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
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
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

function normalizedSearchSummary(
  workEntry: Pick<TimelineWorkEntry, "command" | "searchSummary">,
): string | null {
  if (workEntry.command) {
    const commandClassification = classifyCompactCommand(workEntry.command);
    if (commandClassification.kind === "search") {
      return commandClassification.summary;
    }
  }

  const searchSummary = workEntry.searchSummary?.trim();
  return searchSummary && searchSummary.length > 0 ? searchSummary : null;
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

function normalizedWorkEntryHeading(
  workEntry: Pick<TimelineWorkEntry, "label" | "toolTitle">,
): string {
  return normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label).trim();
}

function isSearchWorkEntry(
  workEntry: Pick<
    TimelineWorkEntry,
    "command" | "itemType" | "label" | "requestKind" | "searchSummary" | "toolTitle"
  >,
): boolean {
  if (normalizedSearchSummary(workEntry)) {
    return true;
  }

  if (workEntry.requestKind !== "command" && workEntry.itemType !== "command_execution") {
    return false;
  }

  return normalizedWorkEntryHeading(workEntry).toLowerCase().startsWith("searching ");
}

function isFileReadWorkEntry(
  workEntry: Pick<TimelineWorkEntry, "label" | "readPaths" | "requestKind" | "toolTitle">,
): boolean {
  if (workEntry.requestKind === "file-read" || (workEntry.readPaths?.length ?? 0) > 0) {
    return true;
  }
  const normalizedLabel = normalizedWorkEntryHeading(workEntry).toLowerCase();
  return normalizedLabel === "read" || normalizedLabel === "read file";
}

function isFileChangeWorkEntry(
  workEntry: Pick<TimelineWorkEntry, "itemType" | "label" | "requestKind" | "toolTitle">,
): boolean {
  if (workEntry.requestKind === "file-change" || workEntry.itemType === "file_change") {
    return true;
  }
  const normalizedLabel = normalizedWorkEntryHeading(workEntry).toLowerCase();
  return normalizedLabel === "file change" || normalizedLabel === "write file";
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

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
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
      const api = readNativeApi();
      if (!api) {
        console.warn("Native API not found. Unable to open file in editor.");
        return;
      }
      const targetPath = workspaceRoot ? resolvePathLinkTarget(filePath, workspaceRoot) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open file in editor.", error);
      });
    },
    [handleFileNavigation, workEntry.turnId, workspaceRoot],
  );

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {heading}
            </span>
            {inlineFilePreview ? (
              <>
                <span className="text-muted-foreground/55"> {" - "}</span>
                <button
                  type="button"
                  className="max-w-full cursor-pointer truncate text-left text-muted-foreground/55 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground/80 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  onClick={() => openFileChip(inlineFilePreview.targetPath)}
                  title={inlineFilePreview.label}
                >
                  {inlineFilePreview.label}
                </button>
                {inlineFilePreview.trailingText ? (
                  <span className="text-muted-foreground/55">{inlineFilePreview.trailingText}</span>
                ) : null}
              </>
            ) : preview ? (
              <span className="text-muted-foreground/55"> - {preview}</span>
            ) : null}
          </p>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {(fileChangeEntry
            ? fileChangePreviews.slice(0, 4)
            : (workEntry.changedFiles?.slice(0, 4) ?? [])
          ).map((file) => {
            const filePath = typeof file === "string" ? file : file.targetPath;
            const fileLabel = typeof file === "string" ? file : file.displayPath;
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                role="button"
                tabIndex={0}
                className="cursor-pointer rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75 transition-colors hover:border-border hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                title={filePath}
                onClick={() => openFileChip(filePath)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  openFileChip(filePath);
                }}
              >
                {fileLabel}
              </span>
            );
          })}
          {(fileChangeEntry ? fileChangePreviews.length : (workEntry.changedFiles?.length ?? 0)) >
            4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +
              {(fileChangeEntry
                ? fileChangePreviews.length
                : (workEntry.changedFiles?.length ?? 0)) - 4}
            </span>
          )}
        </div>
      )}
      {!hasChangedFiles && !inlineFilePreview && commandReadFiles.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {commandReadFiles.slice(0, 4).map((file) => (
            <span
              key={`${workEntry.id}:${file.rawPath}`}
              role="button"
              tabIndex={0}
              className="cursor-pointer rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75 transition-colors hover:border-border hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              title={file.rawPath}
              onClick={() => openFileChip(file.targetPath)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }
                event.preventDefault();
                openFileChip(file.targetPath);
              }}
            >
              {file.displayPath}
            </span>
          ))}
          {commandReadFiles.length > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{commandReadFiles.length - 4}
            </span>
          )}
        </div>
      )}
      {canRenderInlineDiff ? (
        <div className="mt-1 flex items-center justify-between gap-2 pl-6 pr-1">
          <span className="text-[10px] text-muted-foreground/60">
            {formatInlineDiffFileCountLabel(inlineDiffFileCount)}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 px-2 text-[10px] text-muted-foreground/70 hover:text-foreground/85"
            onClick={() => chatDiffContext.onToggleFileChangeDiff(workEntry.id)}
          >
            {inlineDiffExpanded ? "Hide diff" : "Show diff"}
          </Button>
        </div>
      ) : null}
      {inlineDiffExpanded && canRenderExactInlineFileDiff && workEntry.fileChangeId ? (
        <div className="mt-1 pl-6">
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
        </div>
      ) : inlineDiffExpanded && canRenderTurnFallbackInlineDiff && workEntry.turnId ? (
        <div className="mt-1 pl-6">
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
}) {
  const { workEntry, markdownCwd, expandByDefault } = props;
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
      className="group rounded-xl border border-border/60 bg-card/35"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left",
          !hasNestedContent && "cursor-default",
        )}
        disabled={!hasNestedContent}
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground/70">
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
            <span className="inline-flex rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              MCP tool call
            </span>
          </div>
          <p className="mt-1.5 text-sm font-medium text-foreground" title={hoverTitle}>
            {heading}
          </p>
        </div>
      </CollapsibleTrigger>
      {hasNestedContent && (
        <CollapsiblePanel>
          <div className="border-t border-border/60 px-3 py-3">
            <div className="space-y-3">
              {workEntry.mcpInput && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Input
                  </p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-background/70 p-2 font-mono text-[12px] leading-5 text-foreground">
                    {workEntry.mcpInput}
                  </pre>
                </div>
              )}
              {workEntry.mcpResult && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Result
                  </p>
                  <div className="mt-1 max-h-80 overflow-auto rounded-md bg-background/70 p-2 text-[12px] text-foreground">
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
  const [open, setOpen] = useState(Boolean(workEntry.subagentResult));
  const [userOverrodeOpen, setUserOverrodeOpen] = useState(false);

  useEffect(() => {
    if (userOverrodeOpen) {
      return;
    }
    setOpen(Boolean(workEntry.subagentResult));
  }, [userOverrodeOpen, workEntry.subagentResult]);

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview =
    workEntry.subagentDescription ??
    workEntry.detail ??
    workEntry.subagentResult ??
    workEntryPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasNestedContent = Boolean(workEntry.subagentPrompt) || Boolean(workEntry.subagentResult);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setUserOverrodeOpen(true);
    setOpen(nextOpen);
  }, []);

  return (
    <Collapsible className="rounded-lg px-1 py-1" open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-0 py-1 text-left",
          !hasNestedContent && "cursor-default",
        )}
        disabled={!hasNestedContent}
      >
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {heading}
            </span>
            {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
          </p>
          {(workEntry.subagentType || workEntry.subagentModel) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {workEntry.subagentType && (
                <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground/75">
                  {workEntry.subagentType}
                </span>
              )}
              {workEntry.subagentModel && (
                <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75">
                  {workEntry.subagentModel}
                </span>
              )}
            </div>
          )}
        </div>
        {hasNestedContent && (
          <ChevronDownIcon
            className={cn(
              "mt-1 size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200",
              open ? "rotate-180" : "",
            )}
          />
        )}
      </CollapsibleTrigger>
      {hasNestedContent && (
        <CollapsiblePanel>
          <div className="mt-1 ml-6 space-y-2 rounded-lg border border-border/45 bg-background/60 p-3">
            {workEntry.subagentPrompt && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  Tool Call
                </p>
                <div className="text-[12px] text-muted-foreground/80">
                  <ChatMarkdown
                    text={workEntry.subagentPrompt}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              </div>
            )}
            {workEntry.subagentResult && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  Result
                </p>
                <div className="text-[12px] text-muted-foreground/80">
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
