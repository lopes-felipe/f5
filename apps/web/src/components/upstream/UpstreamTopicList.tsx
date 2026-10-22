import type { UpstreamTopicRow } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { HelpCircleIcon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { impactClassName, suggestionChipLabel, upstreamPrUrl } from "./upstreamPage.logic";

const ROW_HEIGHT_PX = 56;

export interface UpstreamTopicListHandle {
  readonly focus: () => void;
}

const UpstreamTopicRowView = (props: {
  readonly row: UpstreamTopicRow;
  readonly repository: string;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly onFocus: () => void;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
}) => {
  const { topic } = props.row;
  const link = props.row.links[0];
  return (
    <div
      role="option"
      aria-selected={props.focused}
      data-topic-id={topic.id}
      className={cn(
        "flex h-14 cursor-default items-center gap-3 border-b border-border/60 px-3 text-sm",
        props.focused && "bg-accent/70",
      )}
      onClick={props.onFocus}
      onDoubleClick={props.onOpen}
    >
      <input
        type="checkbox"
        aria-label={`Select ${topic.title}`}
        tabIndex={-1}
        checked={props.selected}
        onChange={props.onToggle}
        onClick={(event) => event.stopPropagation()}
      />
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", impactClassName(topic.suggestion?.userImpact))}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{topic.title}</span>
          {topic.suggestion && props.row.state === "inbox" && (
            <Badge variant="outline" size="sm" className="shrink-0 tabular-nums">
              {suggestionChipLabel(topic.suggestion)}
            </Badge>
          )}
          {topic.suggestion?.conflict && (
            <Badge variant="warning" size="sm">
              conflict
            </Badge>
          )}
          {topic.suggestion?.question && (
            <HelpCircleIcon className="size-3.5 shrink-0 text-warning" aria-label="Open question" />
          )}
          {topic.decidedBy && props.row.state === "skipped" && topic.decidedBy !== "user" && (
            <Badge variant="outline" size="sm">
              {topic.decidedBy}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 truncate text-xs text-muted-foreground">
          <span className="font-mono">{topic.id}</span>
          <span>
            {props.row.commitCount} commit{props.row.commitCount === 1 ? "" : "s"}
          </span>
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
          <span>{formatRelativeTimeLabel(topic.createdAt)}</span>
          {link && (
            <span className="truncate">
              · {link.threadStatus ?? "thread"}
              {link.prNumber !== null ? ` · PR #${link.prNumber}` : ""}
              {link.outcome ? ` · ${link.outcome.kind}` : ""}
            </span>
          )}
          {props.row.doneBy && <span>· done by {props.row.doneBy}</span>}
        </div>
      </div>
    </div>
  );
};

export const UpstreamTopicList = forwardRef<
  UpstreamTopicListHandle,
  {
    readonly rows: ReadonlyArray<UpstreamTopicRow>;
    readonly repository: string;
    readonly focusedId: string | null;
    readonly selected: ReadonlySet<string>;
    readonly hasMore: boolean;
    readonly loadingMore: boolean;
    readonly onLoadMore: () => void;
    readonly onFocusRow: (id: string) => void;
    readonly onToggleRow: (id: string) => void;
    readonly onOpenRow: (id: string) => void;
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
    () => [focusedId, props.selected, props.repository],
    [focusedId, props.selected, props.repository],
  );
  const { onFocusRow, onToggleRow, onOpenRow } = props;
  const renderItem = useCallback(
    ({ item }: { item: UpstreamTopicRow }) => (
      <UpstreamTopicRowView
        row={item}
        repository={props.repository}
        focused={item.topic.id === focusedId}
        selected={props.selected.has(item.topic.id)}
        onFocus={() => onFocusRow(item.topic.id)}
        onToggle={() => onToggleRow(item.topic.id)}
        onOpen={() => onOpenRow(item.topic.id)}
      />
    ),
    [focusedId, props.selected, props.repository, onFocusRow, onToggleRow, onOpenRow],
  );
  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="Upstream topics"
      aria-multiselectable="true"
      tabIndex={0}
      data-upstream-list-focus="true"
      className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onKeyDown={props.onKeyDown}
    >
      {rows.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">Nothing here.</p>
      ) : (
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
  );
});
