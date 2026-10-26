import type { UpstreamTopicRow } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { CheckIcon, EyeIcon, HelpCircleIcon, SkipForwardIcon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode } from "react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  canAcceptSuggestion,
  formatConfidence,
  impactClassName,
  impactLabel,
  suggestionBadgeVariant,
  suggestionChipLabel,
  suggestionVerb,
  upstreamPrUrl,
} from "./upstreamPage.logic";

const ROW_HEIGHT_PX = 60;

export interface UpstreamTopicListHandle {
  readonly focus: () => void;
}

export type UpstreamRowQuickAction = "accept" | "skip" | "watch";

export interface RowPointerModifiers {
  readonly shift: boolean;
  readonly mod: boolean;
}

const rowElementId = (topicId: string) => `upstream-topic-${topicId}`;

const modifiersOf =(event: React.MouseEvent) => ({ shift: event.shiftKey, mod: event.metaKey || event.ctrlKey });

const eventModifiers = (event: Event | undefined): RowPointerModifiers =>
  event instanceof MouseEvent || event instanceof KeyboardEvent
    ? { shift: event.shiftKey, mod: event.metaKey || event.ctrlKey }
    : { shift: false, mod: false };

function RowExtras(props: { readonly row: UpstreamTopicRow; readonly reasonLabels: Readonly<Record<string, string>> }) {
  const { row } = props;
  const link = row.links[0];
  if (row.state === "done" && row.doneBy) return <span>· done by {row.doneBy}</span>;
  if (row.state === "skipped") {
    const reason = row.topic.reasonKey ? (props.reasonLabels[row.topic.reasonKey] ?? row.topic.reasonKey) : row.topic.reason;
    return reason ? <span className="truncate">· {reason}</span> : null;
  }
  if (link)
    return (
      <span className="truncate">
        · {link.threadStatus ?? "thread"}
        {link.prNumber !== null ? ` · PR #${link.prNumber}${link.prState ? ` ${link.prState}` : ""}` : ""}
        {link.outcome ? ` · ${link.outcome.kind}` : ""}
      </span>
    );
  return null;
}

const UpstreamTopicRowView = (props: {
  readonly row: UpstreamTopicRow;
  readonly repository: string;
  readonly reasonLabels: Readonly<Record<string, string>>;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly quickActions: boolean;
  readonly onClick: (modifiers: RowPointerModifiers) => void;
  readonly onToggle: (modifiers: RowPointerModifiers) => void;
  readonly onOpen: () => void;
  readonly onQuickAction: (action: UpstreamRowQuickAction) => void;
}) => {
  const { topic } = props.row;
  const suggestion = topic.suggestion;
  const areas = suggestion?.areas.slice(0, 3) ?? [];
  return (
    <div
      id={rowElementId(topic.id)}
      role="option"
      // Checked rows are the selection; the focused row is the listbox's active descendant.
      aria-selected={props.selected}
      aria-busy={props.pending || undefined}
      data-topic-id={topic.id}
      className={cn(
        "group relative flex h-[60px] cursor-default items-center gap-3 border-b border-border/60 px-3 text-sm",
        props.focused ? "bg-accent/70" : "hover:bg-accent/30",
        props.selected && !props.focused && "bg-primary/5",
        props.pending && "opacity-50",
      )}
      onClick={(event) => props.onClick(modifiersOf(event))}
      onDoubleClick={props.onOpen}
    >
      {/* The wrapper keeps checkbox clicks from also focusing the row. */}
      <span
        className="flex items-center"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={`Select ${topic.title}`}
          tabIndex={-1}
          checked={props.selected}
          onCheckedChange={(_checked, details) => props.onToggle(eventModifiers(details.event))}
        />
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={impactLabel(suggestion?.userImpact)}
              className={cn("size-2 shrink-0 rounded-full", impactClassName(suggestion?.userImpact))}
            />
          }
        />
        <TooltipPopup>{impactLabel(suggestion?.userImpact)}</TooltipPopup>
      </Tooltip>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{topic.title}</span>
          {suggestion && props.row.state === "inbox" && (
            <Badge variant={suggestionBadgeVariant(suggestion.status)} size="sm" className="shrink-0 tabular-nums">
              {suggestionChipLabel(suggestion)}
            </Badge>
          )}
          {suggestion?.conflict && (
            <Badge variant="warning" size="sm">
              conflict
            </Badge>
          )}
          {suggestion?.question && (
            <HelpCircleIcon className="size-3.5 shrink-0 text-warning" aria-label="Open question" />
          )}
          {topic.decidedBy && props.row.state === "skipped" && topic.decidedBy !== "user" && (
            <Badge variant="outline" size="sm">
              {topic.decidedBy}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 truncate text-xs text-muted-foreground">
          {topic.upstreamPrs.slice(0, 3).map((pr) => (
            <a
              key={pr}
              href={upstreamPrUrl(props.repository, pr)}
              target="_blank"
              rel="noreferrer"
              tabIndex={-1}
              className="hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              #{pr}
            </a>
          ))}
          <span>
            {props.row.commitCount} commit{props.row.commitCount === 1 ? "" : "s"}
          </span>
          {areas.length > 0 && <span className="truncate">{areas.join(", ")}</span>}
          <span className="shrink-0">{formatRelativeTimeLabel(topic.createdAt)}</span>
          <RowExtras row={props.row} reasonLabels={props.reasonLabels} />
        </div>
      </div>
      {props.quickActions && !props.pending && (
        <div
          className="absolute inset-y-0 right-2 hidden items-center gap-1 group-hover:flex"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {canAcceptSuggestion(suggestion) && (
            <Button size="xs" variant="outline" tabIndex={-1} onClick={() => props.onQuickAction("accept")}>
              <CheckIcon />
              Accept {suggestionVerb(suggestion)}
              <span className="text-muted-foreground tabular-nums">{formatConfidence(suggestion.confidence)}</span>
            </Button>
          )}
          <Button size="icon-xs" variant="outline" tabIndex={-1} aria-label="Skip" onClick={() => props.onQuickAction("skip")}>
            <SkipForwardIcon />
          </Button>
          <Button size="icon-xs" variant="outline" tabIndex={-1} aria-label="Watch" onClick={() => props.onQuickAction("watch")}>
            <EyeIcon />
          </Button>
        </div>
      )}
    </div>
  );
};

export function UpstreamTopicListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading topics" className="flex-1">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex h-[60px] items-center gap-3 border-b border-border/60 px-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="size-2 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export const UpstreamTopicList = forwardRef<
  UpstreamTopicListHandle,
  {
    readonly rows: ReadonlyArray<UpstreamTopicRow>;
    readonly repository: string;
    readonly reasonLabels: Readonly<Record<string, string>>;
    readonly focusedId: string | null;
    readonly selected: ReadonlySet<string>;
    readonly pending: ReadonlySet<string>;
    readonly quickActions: boolean;
    readonly hasMore: boolean;
    readonly loadingMore: boolean;
    /** Rendered above the rows: the select-all checkbox or the bulk bar. */
    readonly header: ReactNode;
    /** Rendered instead of the rows when there are none. */
    readonly empty: ReactNode;
    readonly onLoadMore: () => void;
    readonly onClickRow: (id: string, modifiers: RowPointerModifiers) => void;
    readonly onToggleRow: (id: string, modifiers: RowPointerModifiers) => void;
    readonly onOpenRow: (id: string) => void;
    readonly onQuickAction: (id: string, action: UpstreamRowQuickAction) => void;
    readonly onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  }
>(function UpstreamTopicList(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  useImperativeHandle(ref, () => ({ focus: () => containerRef.current?.focus() }), []);
  const { rows, focusedId } = props;
  useEffect(() => {
    if (!focusedId) return;
    const index = rows.findIndex((row) => row.topic.id === focusedId);
    if (index >= 0) void listRef.current?.scrollIndexIntoView({ index, animated: false });
  }, [focusedId, rows]);
  const extraData = useMemo(
    () => [focusedId, props.selected, props.pending, props.repository, props.quickActions],
    [focusedId, props.selected, props.pending, props.repository, props.quickActions],
  );
  const { onClickRow, onToggleRow, onOpenRow, onQuickAction, reasonLabels } = props;
  const renderItem = useCallback(
    ({ item }: { item: UpstreamTopicRow }) => (
      <UpstreamTopicRowView
        row={item}
        repository={props.repository}
        reasonLabels={reasonLabels}
        focused={item.topic.id === focusedId}
        selected={props.selected.has(item.topic.id)}
        pending={props.pending.has(item.topic.id)}
        quickActions={props.quickActions}
        onClick={(modifiers) => onClickRow(item.topic.id, modifiers)}
        onToggle={(modifiers) => onToggleRow(item.topic.id, modifiers)}
        onOpen={() => onOpenRow(item.topic.id)}
        onQuickAction={(action) => onQuickAction(item.topic.id, action)}
      />
    ),
    [
      focusedId,
      props.selected,
      props.pending,
      props.repository,
      props.quickActions,
      reasonLabels,
      onClickRow,
      onToggleRow,
      onOpenRow,
      onQuickAction,
    ],
  );
  const focusedLoaded = focusedId !== null && rows.some((row) => row.topic.id === focusedId);
  // The shortcuts also work from the header (after clicking select-all) and the empty state.
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={props.onKeyDown}>
      {props.header}
      {rows.length === 0 && props.empty}
      <div
        ref={containerRef}
        role="listbox"
        aria-label="Upstream topics"
        aria-multiselectable="true"
        aria-activedescendant={focusedLoaded ? rowElementId(focusedId) : undefined}
        tabIndex={0}
        data-upstream-list-focus="true"
        className={cn(
          "flex min-h-0 flex-col outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          rows.length > 0 && "flex-1",
        )}
      >
        {rows.length > 0 && (
          <LegendList<UpstreamTopicRow>
            ref={listRef}
            data={rows as UpstreamTopicRow[]}
            extraData={extraData}
            keyExtractor={(row) => row.topic.id}
            renderItem={renderItem}
            estimatedItemSize={ROW_HEIGHT_PX}
            getFixedItemSize={() => ROW_HEIGHT_PX}
            drawDistance={ROW_HEIGHT_PX * 20}
            recycleItems
            onEndReached={() => props.hasMore && !props.loadingMore && props.onLoadMore()}
            className="min-h-0 flex-1"
          />
        )}
      </div>
    </div>
  );
});
