import { memo, useEffect, useMemo, useRef } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import type {
  PrHubSection,
  PrHubThreadLink,
  PullRequestKey,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { selectThreadById, useThread } from "../../threadSelectors";
import { resolveThreadStatusPillForThread } from "../../threadStatus";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { attentionAccentClass, isPrStalled } from "./prHubPresentation";
import {
  PR_QUEUE_SECTION_HINTS,
  PR_QUEUE_SECTION_LABELS,
  prRowChecks,
  prRowPrimaryAction,
  prRowReview,
  type PrRowCell,
  type PrTone,
} from "./prQueueModel";
import type { PrQueueActionKind } from "./PrQueueActions";
import type { PrQueueGroup } from "./usePrQueue";

/** Longer tables render through LegendList to stay responsive. */
const VIRTUALIZE_THRESHOLD = 60;

export const PR_TONE_DOT: Record<PrTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  pending: "bg-info",
  muted: "bg-border",
};

/** Column widths shared by the header and every row; narrow tables drop the quiet ones. */
const COLUMN = {
  review: "hidden w-24 shrink-0 @xl/prqueue:flex",
  checks: "hidden w-22 shrink-0 @xl/prqueue:flex",
  size: "hidden w-24 shrink-0 justify-end @3xl/prqueue:flex",
  updated: "hidden w-16 shrink-0 justify-end @md/prqueue:flex",
  action: "flex w-36 shrink-0 justify-end",
} as const;

/** The first linked thread that is working right now, so a row can point at it. */
export function useRunningPrThread(links: readonly PrHubThreadLink[] | undefined): ThreadId | null {
  return useStore((state) => {
    for (const link of links ?? []) {
      const status = selectThreadById(state, link.threadId)?.session?.status;
      if (status === "running" || status === "connecting") return link.threadId;
    }
    return null;
  });
}

export function PrThreadChip({
  link,
  onOpen,
}: {
  link: PrHubThreadLink;
  onOpen: (threadId: ThreadId) => void;
}) {
  const thread = useThread(link.threadId);
  const pill = useMemo(() => (thread ? resolveThreadStatusPillForThread(thread) : null), [thread]);
  const title = thread?.title || link.title || "Thread";
  return (
    <button
      type="button"
      title={pill ? `${title} · ${pill.label}` : title}
      aria-label={`Open thread ${title}${pill ? `, ${pill.label}` : ""}`}
      className="inline-flex max-w-44 min-w-0 items-center gap-1 rounded-sm bg-secondary px-1.5 py-px text-2xs text-secondary-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(link.threadId);
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          pill ? pill.dotClass : "bg-border",
          pill?.pulse && "motion-safe:animate-pulse",
        )}
      />
      <span className="truncate">{title}</span>
    </button>
  );
}

function Cell({ cell, className }: { cell: PrRowCell; className: string }) {
  return (
    <span className={cn("items-center gap-1.5 text-xs", className)}>
      {cell.tone === "muted" ? null : (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", PR_TONE_DOT[cell.tone])}
        />
      )}
      <span className={cell.tone === "muted" ? "text-faint-foreground" : "text-foreground"}>
        {cell.label}
      </span>
    </span>
  );
}

interface RowProps {
  pr: TrackedPullRequest;
  links: readonly PrHubThreadLink[] | undefined;
  viewerLogin: string | null;
  isCursor: boolean;
  isOpen: boolean;
  stalledHours: number;
  now: number;
  onSelect: (key: PullRequestKey) => void;
  onOpenPage: (key: PullRequestKey) => void;
  onAction: (pr: TrackedPullRequest, kind: PrQueueActionKind) => void;
  onOpenThread: (threadId: ThreadId) => void;
}

const PrQueueRow = memo(function PrQueueRow({
  pr,
  links,
  viewerLogin,
  isCursor,
  isOpen,
  stalledHours,
  now,
  onSelect,
  onOpenPage,
  onAction,
  onOpenThread,
}: RowProps) {
  const runningThreadId = useRunningPrThread(links);
  const action = prRowPrimaryAction(pr, { runningThreadId });
  const reference = `${pr.repository.nameWithOwner}#${pr.number}`;
  const showAuthor = pr.author && pr.author.toLowerCase() !== viewerLogin?.toLowerCase();
  return (
    <div
      role="option"
      aria-selected={isCursor}
      data-pr-key={pr.key}
      data-open={isOpen || undefined}
      onClick={() => onSelect(pr.key)}
      onDoubleClick={() => onOpenPage(pr.key)}
      className={cn(
        "flex w-full cursor-default items-center gap-3 border-b border-border px-4 py-2 text-left",
        isOpen
          ? "bg-primary/8 ring-1 ring-inset ring-primary/35"
          : isCursor
            ? "bg-accent/40 ring-1 ring-inset ring-border"
            : "hover:bg-accent/24",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", attentionAccentClass(pr))}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-sm leading-snug text-foreground",
            pr.notificationPending && "font-semibold",
          )}
        >
          {pr.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate font-mono">{reference}</span>
          {showAuthor ? <span className="shrink-0">· {pr.author}</span> : null}
          {pr.isDraft ? <span className="shrink-0">· Draft</span> : null}
          {isPrStalled(pr, stalledHours, now) ? (
            <span className="shrink-0 text-warning-foreground">· Stalled</span>
          ) : null}
          {links?.slice(0, 2).map((link) => (
            <PrThreadChip key={link.threadId} link={link} onOpen={onOpenThread} />
          ))}
          {links && links.length > 2 ? (
            <span className="shrink-0 text-2xs">+{links.length - 2}</span>
          ) : null}
        </span>
      </span>
      <Cell cell={prRowReview(pr)} className={COLUMN.review} />
      <Cell cell={prRowChecks(pr)} className={COLUMN.checks} />
      <span className={cn("gap-1.5 text-xs tabular-nums", COLUMN.size)}>
        <span className="text-success-foreground">+{pr.additions}</span>
        <span className="text-destructive-foreground">−{pr.deletions}</span>
      </span>
      <span
        className={cn("text-xs text-muted-foreground tabular-nums", COLUMN.updated)}
        title={formatAbsoluteTimeLabel(pr.updatedAt)}
      >
        {formatRelativeTimeLabel(pr.updatedAt, now).replace(/ ago$/, "")}
      </span>
      <span className={COLUMN.action}>
        {action ? (
          <Button
            size="xs"
            variant="outline"
            aria-label={`${action.label}: ${reference}`}
            onClick={(event) => {
              event.stopPropagation();
              onAction(pr, action.kind);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {action.label}
          </Button>
        ) : null}
      </span>
    </div>
  );
});

function SectionHeader({
  group,
  section,
  onToggle,
}: {
  group: PrQueueGroup;
  section: PrHubSection;
  onToggle: (section: PrHubSection) => void;
}) {
  const content = (
    <>
      {group.collapsed === null ? null : (
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !group.collapsed && "rotate-90",
          )}
        />
      )}
      <span className="text-xs font-medium text-foreground">
        {PR_QUEUE_SECTION_LABELS[section]}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {group.count}
        {group.countIsPartial ? "+" : ""}
      </span>
    </>
  );
  const className =
    "flex w-full items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-left";
  return group.collapsed === null ? (
    <div className={className} title={PR_QUEUE_SECTION_HINTS[section]}>
      {content}
    </div>
  ) : (
    <button
      type="button"
      aria-expanded={!group.collapsed}
      title={PR_QUEUE_SECTION_HINTS[section]}
      className={cn(
        className,
        "hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
      )}
      onClick={() => onToggle(section)}
    >
      {content}
    </button>
  );
}

export function PrQueueSkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-border px-4 py-2">
          <Skeleton className="size-2 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

type Item =
  | { readonly type: "header"; readonly id: string; readonly group: PrQueueGroup }
  | { readonly type: "row"; readonly id: string; readonly pr: TrackedPullRequest }
  | { readonly type: "loading"; readonly id: string }
  | { readonly type: "error"; readonly id: string; readonly group: PrQueueGroup }
  | { readonly type: "more"; readonly id: string; readonly group: PrQueueGroup };

function itemsOf(groups: readonly PrQueueGroup[]): Item[] {
  const items: Item[] = [];
  for (const group of groups) {
    const id = group.section ?? "status";
    if (group.section) items.push({ type: "header", id: `header:${id}`, group });
    if (group.collapsed) continue;
    for (const pr of group.rows) items.push({ type: "row", id: pr.key, pr });
    if (group.isLoading && group.rows.length === 0)
      items.push({ type: "loading", id: `load:${id}` });
    if (group.isError) items.push({ type: "error", id: `error:${id}`, group });
    else if (group.hasMore) items.push({ type: "more", id: `more:${id}`, group });
  }
  return items;
}

/**
 * The queue: section headers, their rows, and each section's own "Show more" and error
 * rows. Selection is owned by the parent; the row under the cursor stays in view.
 */
export function PrQueueTable({
  groups,
  threadLinks,
  viewerLogin,
  cursorKey,
  openKey,
  stalledHours,
  now,
  isStale,
  onSelect,
  onOpenPage,
  onAction,
  onOpenThread,
  onToggleSection,
}: {
  groups: readonly PrQueueGroup[];
  threadLinks: ReadonlyMap<string, readonly PrHubThreadLink[]>;
  viewerLogin: string | null;
  cursorKey: PullRequestKey | null;
  /** The pull request shown in the peek. */
  openKey: PullRequestKey | null;
  stalledHours: number;
  now: number;
  isStale: boolean;
  onSelect: (key: PullRequestKey) => void;
  onOpenPage: (key: PullRequestKey) => void;
  onAction: (pr: TrackedPullRequest, kind: PrQueueActionKind) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onToggleSection: (section: PrHubSection) => void;
}) {
  const items = itemsOf(groups);
  const virtualize = items.length > VIRTUALIZE_THRESHOLD;
  const cursorIndex = cursorKey ? items.findIndex((item) => item.id === cursorKey) : -1;
  const listRef = useRef<LegendListRef | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (cursorIndex < 0 || !cursorKey) return;
    if (virtualize) listRef.current?.scrollIndexIntoView?.({ index: cursorIndex, animated: false });
    else
      rootRef.current
        ?.querySelector(`[data-pr-key="${CSS.escape(cursorKey)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [cursorIndex, cursorKey, virtualize]);

  const renderItem = (item: Item) => {
    switch (item.type) {
      case "header":
        return (
          <SectionHeader
            group={item.group}
            section={item.group.section!}
            onToggle={onToggleSection}
          />
        );
      case "row":
        return (
          <PrQueueRow
            pr={item.pr}
            links={threadLinks.get(item.pr.key)}
            viewerLogin={viewerLogin}
            isCursor={item.pr.key === cursorKey}
            isOpen={item.pr.key === openKey}
            stalledHours={stalledHours}
            now={now}
            onSelect={onSelect}
            onOpenPage={onOpenPage}
            onAction={onAction}
            onOpenThread={onOpenThread}
          />
        );
      case "loading":
        return <PrQueueSkeletonRows />;
      case "error":
        return (
          <div
            role="alert"
            className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs text-destructive-foreground"
          >
            Could not load these pull requests.
            <Button size="xs" variant="outline" onClick={item.group.retry}>
              Retry
            </Button>
          </div>
        );
      case "more":
        return (
          <div className="border-b border-border px-4 py-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={item.group.isLoadingMore || isStale}
              onClick={item.group.loadMore}
            >
              {item.group.isLoadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        );
    }
  };

  return (
    <div
      ref={rootRef}
      className="@container/prqueue flex min-h-0 min-w-0 flex-1 flex-col"
      aria-busy={isStale}
    >
      <div
        aria-hidden="true"
        className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5 text-2xs uppercase tracking-wide text-muted-foreground"
      >
        <span className="size-2 shrink-0" />
        <span className="min-w-0 flex-1">Pull request</span>
        <span className={COLUMN.review}>Review</span>
        <span className={COLUMN.checks}>Checks</span>
        <span className={COLUMN.size}>Size</span>
        <span className={COLUMN.updated}>Updated</span>
        <span className={COLUMN.action}>Next step</span>
      </div>
      <div
        role="listbox"
        aria-label="Pull requests"
        className={cn(
          "min-h-0 flex-1 transition-opacity",
          !virtualize && "overflow-y-auto",
          isStale && "opacity-60",
        )}
      >
        {virtualize ? (
          <LegendList<Item>
            ref={listRef}
            data={items}
            extraData={`${cursorKey}:${openKey}:${isStale}:${now}`}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => renderItem(item)}
            estimatedItemSize={49}
            style={{ height: "100%" }}
          />
        ) : (
          items.map((item) => <div key={item.id}>{renderItem(item)}</div>)
        )}
      </div>
    </div>
  );
}
