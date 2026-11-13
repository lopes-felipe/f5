import type {
  ProjectId,
  UpstreamControlPortQueueInput,
  UpstreamOverview,
  UpstreamPortQueueBucket,
  UpstreamPortQueueEntry,
  UpstreamPortQueueView,
} from "@t3tools/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  HourglassIcon,
  LoaderIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { upstreamPortsQueryKeys } from "../../lib/upstreamPortsReactQuery";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { UnderlineTabs } from "../ui/underline-tabs";
import { ConfirmDialog } from "./UpstreamDialogs";

type BadgeVariant = "warning" | "info" | "attention" | "outline" | "primary-soft" | "success" | "secondary";

export const QUEUE_BUCKET_LABELS: Record<UpstreamPortQueueBucket, string> = {
  queued: "Queued",
  waiting: "Waiting on files",
  executing: "Running",
  "needs-attention": "Needs attention",
  "awaiting-review": "Awaiting review",
  done: "Done",
  recorded: "Recorded",
  resolved: "Decided by hand",
  superseded: "Superseded",
  omitted: "Left out",
  cancelled: "Cancelled",
};

const BUCKET_STYLE: Record<UpstreamPortQueueBucket, { readonly icon: LucideIcon; readonly variant: BadgeVariant }> = {
  queued: { icon: CircleDashedIcon, variant: "outline" },
  waiting: { icon: HourglassIcon, variant: "attention" },
  executing: { icon: LoaderIcon, variant: "info" },
  "needs-attention": { icon: CircleAlertIcon, variant: "warning" },
  "awaiting-review": { icon: GitPullRequestIcon, variant: "primary-soft" },
  done: { icon: CircleCheckIcon, variant: "success" },
  recorded: { icon: CircleCheckIcon, variant: "success" },
  resolved: { icon: CircleDotIcon, variant: "secondary" },
  superseded: { icon: CircleSlashIcon, variant: "outline" },
  omitted: { icon: CircleSlashIcon, variant: "outline" },
  cancelled: { icon: CircleSlashIcon, variant: "outline" },
};

/** Port results as the user reads them; unknown results show as written. */
const RESULT_LABELS: Record<string, string> = {
  pr: "PR opened",
  equivalent: "Already in F5",
  "not-applicable": "Not applicable",
  "no-outcome": "No outcome reported",
  failed: "Failed",
  error: "Failed",
  "start-failed": "Failed to start",
  interrupted: "Interrupted",
  archived: "Thread archived",
  missing: "Thread missing",
  rejected: "Rejected",
  canceled: "Cancelled",
  "not-ready": "No longer Ready",
  "epoch-changed": "Topic changed",
};
export const queueResultLabel = (result: string) => RESULT_LABELS[result] ?? result;

const TOPICS_COLLAPSED = 3;
const POLL_MS = 120_000;
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The Upstream page's Queue view: jobs in three tabs, live work first. Topics
 * open in the page's detail pane through `onOpenTopic`.
 */
export function UpstreamQueuePanel(props: {
  readonly projectId: ProjectId;
  readonly overview: UpstreamOverview;
  readonly readOnly: boolean;
  readonly view: UpstreamPortQueueView;
  readonly onViewChange: (view: UpstreamPortQueueView) => void;
  readonly focusedTopic: string | null;
  readonly onOpenTopic: (topicId: string) => void;
  /** Ready topics whose port failed; opens Start port for them. */
  readonly onRetry: (topicIds: string[]) => void;
}) {
  const { projectId, view } = props;
  const queue = props.overview.portQueue;
  const client = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const query = useInfiniteQuery({
    // Under the project's queue key, so queue pushes refresh every tab.
    queryKey: [...upstreamPortsQueryKeys.queue(projectId), view, view === "history" && includeInactive],
    queryFn: ({ pageParam }) =>
      ensureNativeApi().upstreamPorts.getPortQueue({
        projectId,
        view,
        ...(view === "history" && includeInactive ? { includeInactive: true } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // Reading the queue refreshes merge evidence while ports await review.
    refetchInterval: (current) => {
      const first = current.state.data?.pages[0];
      return first && (first.viewCounts.active > 0 || first.counts.awaitingReview > 0) ? POLL_MS : false;
    },
  });
  const first = query.data?.pages[0];
  // Offset pages can repeat an entry when the queue shifts between page loads.
  const entries = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? [])
      .flatMap((page) => page.entries)
      .filter((entry) => !seen.has(entry.entryId) && Boolean(seen.add(entry.entryId)));
  }, [query.data]);
  /** "Queued #k": the place in line among jobs that have not started. */
  const queuedNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    if (view === "active")
      for (const entry of entries)
        if (entry.bucket === "queued" || entry.bucket === "waiting") numbers.set(entry.entryId, numbers.size + 1);
    return numbers;
  }, [entries, view]);

  const run =async (title: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await Promise.all([
        client.invalidateQueries({ queryKey: upstreamPortsQueryKeys.queue(projectId) }),
        client.invalidateQueries({ queryKey: upstreamPortsQueryKeys.overview(projectId) }),
      ]);
    } catch (error) {
      toastManager.add({ type: "error", title, description: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const control = (input: UpstreamControlPortQueueInput) =>
    run("Could not update the port queue", () => ensureNativeApi().upstreamPorts.controlPortQueue(input));
  const dequeue = (entry: UpstreamPortQueueEntry) =>
    run("Could not remove from the queue", () =>
      ensureNativeApi().upstreamPorts.dequeuePort({
        projectId,
        topicIds: entry.topics.filter((topic) => topic.bucket === "queued" || topic.bucket === "waiting").map(
          (topic) => topic.topicId,
        ) as never,
      }),
    );

  const disabled = props.readOnly || busy;
  const statusParts = [
    `Running ${queue.running} of ${queue.concurrency} ${queue.concurrency === 1 ? "job" : "jobs"}`,
    queue.queuedThreads > 0
      ? `${plural(queue.queuedThreads, "queued job")} (${plural(queue.queuedTopics, "topic")})`
      : "Nothing queued",
    ...(queue.waitingOnFiles > 0 ? [`${queue.waitingOnFiles.toLocaleString()} waiting on files`] : []),
  ];
  const tabs = first?.viewCounts;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm" data-testid="queue-status">
            {statusParts.join(" · ")}
          </p>
          {queue.paused ? (
            <Badge variant="warning">Paused</Badge>
          ) : queue.hold ? (
            <Badge variant="warning" title={queue.hold.message}>
              {queue.hold.retryAt
                ? `Waiting until ${new Date(queue.hold.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : "Waiting"}
            </Badge>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => void control({ projectId, action: queue.paused ? "resume" : "pause" })}
            >
              {queue.paused ? <PlayIcon /> : <PauseIcon />}
              {queue.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || queue.queuedThreads === 0}
              onClick={() => setClearing(true)}
            >
              Clear queued{queue.queuedThreads > 0 ? ` (${queue.queuedThreads.toLocaleString()})` : ""}
            </Button>
          </div>
        </div>
        {queue.pausedReason && (
          <Alert variant="warning" className="py-2">
            <TriangleAlertIcon />
            <AlertDescription>{queue.pausedReason}</AlertDescription>
          </Alert>
        )}
        {queue.hold && !queue.paused && queue.hold.message && (
          <Alert variant="info" className="py-2">
            <HourglassIcon />
            <AlertDescription>
              {queue.hold.message}
              {queue.hold.retryAt && ` Retrying ${formatAbsoluteTimeLabel(queue.hold.retryAt)}.`}
            </AlertDescription>
          </Alert>
        )}
        {first?.baseRefreshError && (
          <Alert variant="warning" className="py-2">
            <TriangleAlertIcon />
            <AlertDescription>Could not check which ports merged: {first.baseRefreshError}</AlertDescription>
          </Alert>
        )}
        <UnderlineTabs
          aria-label="Queue views"
          value={view}
          onValueChange={props.onViewChange}
          tabs={[
            { value: "active" as const, label: "Active", count: tabs?.active },
            { value: "needs-you" as const, label: "Needs you", count: tabs?.needsYou, warn: true },
            { value: "history" as const, label: "History", count: tabs?.history },
          ].map((tab) => ({
            value: tab.value,
            label: tab.label,
            adornment:
              tab.count !== undefined ? (
                <Badge size="sm" variant={tab.warn && tab.count > 0 ? "warning" : "outline"} className="tabular-nums">
                  {tab.count.toLocaleString()}
                </Badge>
              ) : undefined,
          }))}
          trailing={
            first?.baseEvidenceAt ? (
              <span
                className="pb-2 text-xs text-muted-foreground"
                title={formatAbsoluteTimeLabel(first.baseEvidenceAt)}
              >
                Merges checked {formatRelativeTimeLabel(first.baseEvidenceAt)}
              </span>
            ) : undefined
          }
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {view === "history" && tabs && (tabs.inactive > 0 || includeInactive) && (
          <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
            Show cancelled and superseded ({tabs.inactive.toLocaleString()})
          </label>
        )}
        {query.error && !query.data && (
          <div role="alert" className="space-y-2">
            <p className="text-destructive-foreground">{errorText(query.error)}</p>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {query.isPending && <p className="p-2 text-muted-foreground">Loading queue…</p>}
        {query.data && entries.length === 0 && <EmptyView view={view} />}
        <ol aria-label="Port queue jobs" className="space-y-2">
          {entries.map((entry) => (
            <QueueJob
              key={entry.entryId}
              entry={entry}
              queuedIndex={queuedNumbers.get(entry.entryId) ?? null}
              focusedTopic={props.focusedTopic}
              disabled={disabled}
              onOpenTopic={props.onOpenTopic}
              onStartAnyway={() => void control({ projectId, action: "ignore-conflicts", entryId: entry.entryId })}
              onRemove={() => void dequeue(entry)}
              onRetry={props.onRetry}
            />
          ))}
        </ol>
        {query.hasNextPage && (
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </div>
      <ConfirmDialog
        request={
          clearing
            ? {
                title: `Clear ${plural(queue.queuedThreads, "queued job")}?`,
                description: "Jobs that have not started are cancelled. Running port threads continue.",
                confirmLabel: "Clear queued",
                onConfirm: () => void control({ projectId, action: "clear" }),
              }
            : null
        }
        onClose={() => setClearing(false)}
      />
    </div>
  );
}

function EmptyView(props: { readonly view: UpstreamPortQueueView }) {
  const text =
    props.view === "active"
      ? "Nothing is running or queued. Queue Ready topics from the Ready list."
      : props.view === "needs-you"
        ? "No ports need a decision or review."
        : "No finished ports yet.";
  return <p className="p-2 text-muted-foreground">{text}</p>;
}

function QueueJob(props: {
  readonly entry: UpstreamPortQueueEntry;
  readonly queuedIndex: number | null;
  readonly focusedTopic: string | null;
  readonly disabled: boolean;
  readonly onOpenTopic: (topicId: string) => void;
  readonly onStartAnyway: () => void;
  readonly onRemove: () => void;
  readonly onRetry: (topicIds: string[]) => void;
}) {
  const { entry } = props;
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const style = BUCKET_STYLE[entry.bucket];
  const Icon = style.icon;
  const label =
    props.queuedIndex !== null && entry.bucket === "queued"
      ? `Queued #${props.queuedIndex}`
      : QUEUE_BUCKET_LABELS[entry.bucket];
  const time = entry.finishedAt ?? entry.createdAt;
  const timeLabel = `${entry.finishedAt ? "Finished" : "Queued"} ${formatRelativeTimeLabel(time)}`;
  const topics = expanded ? entry.topics : entry.topics.slice(0, TOPICS_COLLAPSED);
  const retryable = entry.topics
    .filter((topic) => topic.bucket === "needs-attention" && topic.state === "ready")
    .map((topic) => topic.topicId);
  const queued = entry.bucket === "queued" || entry.bucket === "waiting";
  const openThread = (threadId: string) => void navigate({ to: "/$threadId", params: { threadId } });

  return (
    <li
      className={cn(
        "space-y-2 rounded-lg border bg-card p-3",
        entry.bucket === "needs-attention" && "border-warning/40",
      )}
      aria-label={`${label}: ${entry.thread?.title ?? entry.topics[0]?.title ?? entry.entryId}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={style.variant} className="gap-1">
          <Icon className={cn("size-3", entry.bucket === "executing" && "animate-spin")} aria-hidden="true" />
          {label}
        </Badge>
        {entry.threadId ? (
          <Button
            size="xs"
            variant="link"
            className="h-auto min-w-0 truncate px-0 font-medium"
            onClick={() => openThread(entry.threadId!)}
          >
            {entry.thread?.title ?? "Untitled thread"}
          </Button>
        ) : (
          <span className="text-muted-foreground">Not started</span>
        )}
        {entry.pr && (
          <a
            href={entry.pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            <GitPullRequestIcon className="size-3" aria-hidden="true" />
            {entry.pr.number ? `#${entry.pr.number}` : "Pull request"}
          </a>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span title={formatAbsoluteTimeLabel(time)}>{timeLabel}</span>
          {entry.fileCount > 0 && <span>{plural(entry.fileCount, "file")}</span>}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Job actions" disabled={props.disabled} />}
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {entry.threadId && <MenuItem onClick={() => openThread(entry.threadId!)}>Open thread</MenuItem>}
              {entry.pr && (
                <MenuItem onClick={() => window.open(entry.pr!.url, "_blank", "noopener,noreferrer")}>
                  Open pull request
                  <ExternalLinkIcon className="ms-auto size-3" />
                </MenuItem>
              )}
              {entry.bucket === "waiting" && <MenuItem onClick={props.onStartAnyway}>Start without waiting</MenuItem>}
              {queued && <MenuItem onClick={props.onRemove}>Remove from queue</MenuItem>}
              {retryable.length > 0 && (
                <MenuItem onClick={() => props.onRetry(retryable)}>Retry port…</MenuItem>
              )}
              {!entry.threadId && !entry.pr && !queued && retryable.length === 0 && (
                <MenuItem disabled>No actions</MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </span>
      </div>
      <ul className="space-y-1">
        {topics.map((topic) => {
          const topicStyle = BUCKET_STYLE[topic.bucket];
          const showResult =
            topic.result !== null && (topic.bucket === "needs-attention" || topic.bucket === "awaiting-review");
          return (
            <li key={topic.topicId} className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className={cn(
                  "min-w-0 truncate text-start hover:underline",
                  props.focusedTopic === topic.topicId && "font-medium text-primary",
                )}
                aria-current={props.focusedTopic === topic.topicId ? "true" : undefined}
                onClick={() => props.onOpenTopic(topic.topicId)}
              >
                {topic.title}
              </button>
              {topic.bucket !== entry.bucket && (
                <Badge size="sm" variant={topicStyle.variant} className="shrink-0">
                  {QUEUE_BUCKET_LABELS[topic.bucket]}
                </Badge>
              )}
              {showResult && (
                <span className="shrink-0 text-xs text-muted-foreground">{queueResultLabel(topic.result!)}</span>
              )}
            </li>
          );
        })}
      </ul>
      {entry.topics.length > TOPICS_COLLAPSED && (
        <Button size="xs" variant="link" className="h-auto px-0" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer topics" : `+${(entry.topics.length - TOPICS_COLLAPSED).toLocaleString()} more topics`}
        </Button>
      )}
      {entry.reason && <p className="text-xs text-muted-foreground">{entry.reason}</p>}
      {entry.waitingOn.length > 0 && (
        <div className="flex flex-wrap items-start gap-2 rounded-md bg-muted/50 p-2 text-xs">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-muted-foreground">Waiting on files changed by</p>
            <ul className="space-y-1">
              {entry.waitingOn.map((blocker) => (
                <li key={blocker.threadId ?? blocker.topicId} className="flex flex-wrap items-center gap-1.5">
                  {blocker.threadId ? (
                    <Button
                      size="xs"
                      variant="link"
                      className="h-auto px-0"
                      onClick={() => openThread(blocker.threadId!)}
                    >
                      {blocker.threadTitle ?? blocker.topicTitles[0] ?? blocker.topicId}
                    </Button>
                  ) : (
                    <span>{blocker.topicTitles[0] ?? blocker.topicId}</span>
                  )}
                  {blocker.prUrl && (
                    <a
                      href={blocker.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {blocker.prNumber ? `#${blocker.prNumber}` : "PR"}
                    </a>
                  )}
                  {blocker.topicTitles.length > 1 && (
                    <span className="text-muted-foreground" title={blocker.topicTitles.join("\n")}>
                      {plural(blocker.topicTitles.length, "topic")}
                    </span>
                  )}
                  {blocker.needsAttention && (
                    <Badge size="sm" variant="warning">
                      Blocker needs attention
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onStartAnyway}>
            Start anyway
          </Button>
        </div>
      )}
    </li>
  );
}
