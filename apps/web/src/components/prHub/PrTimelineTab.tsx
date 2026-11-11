import { ForgeReactionControl } from "./ForgeReactionControl";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { PrSendToAgent } from "./PrSendToAgent";
import { PrMarkdown } from "./PrMarkdown";
import { PrAuthorLink } from "./PrAuthorLink";
import { createContext, useContext, useEffect, useState, type SetStateAction } from "react";
import { LegendList } from "@legendapp/list/react";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PencilIcon,
} from "lucide-react";
import type {
  PrHubReviewThread,
  PrHubTimelineComment,
  TrackedPullRequest,
} from "@t3tools/contracts";

import {
  prHubReviewThreadCommentsQueryOptions,
  prHubReviewThreadsQueryOptions,
  prHubTimelineQueryOptions,
} from "../../lib/prHubReactQuery";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PrReactionBar } from "./PrReactionBar";
import { prDetailCapability } from "./prDetails.logic";
import {
  groupTimelineReviewThreads,
  type PrTimelineThreadRow,
  type PrTimelineRow,
} from "./prTimelineThreads";
import type { usePrDetailMutations } from "./usePrDetailMutations";

function TimelineSeparator() {
  return <div className="h-3" />;
}

const TimelineState = createContext<{
  values: ReadonlyMap<string, unknown>;
  update: (key: string, initial: unknown, value: (previous: unknown) => unknown) => void;
} | null>(null);

/** State belongs to the tab, so virtual row eviction cannot discard a draft or disclosure. */
function useTimelineValue<T>(key: string, initial: T): [T, (value: SetStateAction<T>) => void] {
  const state = useContext(TimelineState)!;
  const current = state.values.has(key) ? (state.values.get(key) as T) : initial;
  return [
    current,
    (value) =>
      state.update(key, initial, (previous) =>
        typeof value === "function" ? (value as (previous: T) => T)(previous as T) : value,
      ),
  ];
}

function TimelineComment({
  pr,
  comment,
  mutations,
  showPath = true,
}: {
  pr: TrackedPullRequest;
  comment: PrHubTimelineComment;
  mutations: ReturnType<typeof usePrDetailMutations>;
  showPath?: boolean;
}) {
  const [isEditing, setIsEditing] = useTimelineValue(pr.key + ":editing:" + comment.id, false);
  const [draft, setDraft] = useTimelineValue(pr.key + ":draft:" + comment.id, comment.body);
  const editCapability = prDetailCapability(pr, "edit-comment");
  const reactionCapability = prDetailCapability(pr, "react");
  const canEdit =
    comment.viewerCanUpdate &&
    (pr.provider !== "github" || comment.databaseId !== null) &&
    comment.kind !== "review" &&
    editCapability.supported;

  useEffect(() => {
    if (!isEditing) setDraft(comment.body);
  }, [comment.body, isEditing]);

  return (
    <article className="space-y-3 rounded-lg border border-border p-3">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 text-sm">
            <PrAuthorLink prUrl={pr.url} login={comment.author?.login} />{" "}
            <span className="text-muted-foreground">
              {comment.kind === "review-comment"
                ? "review comment"
                : comment.kind === "review"
                  ? "review"
                  : "comment"}{" "}
              · {formatRelativeTimeLabel(comment.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {comment.reviewState ? (
            <Badge variant="outline" size="sm">
              {comment.reviewState.toLowerCase().replaceAll("_", " ")}
            </Badge>
          ) : null}
          {comment.viewerCanUpdate &&
          comment.kind !== "review" &&
          (pr.provider === "github" || pr.forgeCapabilities?.edit.comment) ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Edit comment"
              title={
                canEdit ? undefined : (editCapability.reason ?? "This comment cannot be edited.")
              }
              disabled={!canEdit || mutations.updateComment.isPending}
              onClick={() => setIsEditing(true)}
            >
              <PencilIcon />
            </Button>
          ) : null}
        </div>
      </header>

      {comment.path ? (
        <PrSendToAgent pr={pr} body={comment.body} path={comment.path} line={comment.line} />
      ) : null}
      {showPath && comment.path ? (
        <p className="font-mono text-xs text-muted-foreground">
          {comment.path}
          {comment.line !== null ? `:${comment.line}` : ""}
        </p>
      ) : null}

      {isEditing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex gap-2">
            {pr.provider !== "github" ? (
              <ForgeOperationPanel
                pr={pr}
                payload={{
                  kind: "edit-comment",
                  commentId: comment.databaseId ?? comment.id,
                  body: draft.trim(),
                }}
                label={`Edit comment ${comment.databaseId ?? comment.id}`}
                onSucceeded={() => setIsEditing(false)}
              />
            ) : (
              <Button
                size="sm"
                disabled={!draft.trim() || mutations.updateComment.isPending}
                onClick={() => {
                  if (!comment.databaseId || comment.kind === "review") return;
                  void mutations.updateComment
                    .mutateAsync({
                      key: pr.key,
                      commentId: comment.databaseId,
                      kind: comment.kind,
                      body: draft.trim(),
                    })
                    .then(() => setIsEditing(false))
                    .catch(() => undefined);
                }}
              >
                {mutations.updateComment.isPending ? "Saving…" : "Save"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : comment.body.trim() ? (
        <PrMarkdown body={comment.body} host={pr.host} provider={pr.provider} />
      ) : (
        <p className="text-sm italic text-muted-foreground">No written comment.</p>
      )}

      {pr.provider === "github" ? (
        <PrReactionBar
          prKey={pr.key}
          subjectId={comment.kind === "review" ? null : comment.id}
          reactions={comment.reactions}
          disabledReason={reactionCapability.supported ? null : reactionCapability.reason}
          isPending={mutations.setReaction.isPending}
          onSetReaction={(input) => mutations.setReaction.mutate(input)}
        />
      ) : comment.kind !== "review" ? (
        <ForgeReactionControl pr={pr} commentId={comment.databaseId ?? comment.id} />
      ) : null}
    </article>
  );
}

function TimelineReviewThread({
  pr,
  row,
  mutations,
}: {
  pr: TrackedPullRequest;
  row: PrTimelineThreadRow;
  mutations: ReturnType<typeof usePrDetailMutations>;
}) {
  const { thread, root, replies } = row;
  // Resolved and dismissed threads fold as a unit, so a settled finding does not crowd the
  // timeline.
  const [expanded, setExpanded] = useTimelineValue(
    [pr.key, "thread", thread.id, thread.isResolved, row.dismissed].join(":"),
    !thread.isResolved && !row.dismissed,
  );
  const replyCount = replies.length;
  const line = thread.line ?? thread.originalLine;
  const path = thread.path ?? root.path;

  return (
    <section className="space-y-2" aria-label={`Review thread on ${path ?? "a file"}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <FileCode2Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono">
          {path ?? "file"}
          {line !== null ? `:${line}` : ""}
        </span>
        {thread.isResolved ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success">
            <CircleCheckIcon aria-hidden className="size-3" />
            Resolved
          </span>
        ) : null}
        {row.dismissed ? <span className="shrink-0 font-medium">Review dismissed</span> : null}
        {thread.isOutdated ? <span className="shrink-0 font-medium">Outdated</span> : null}
        {expanded ? null : (
          <span className="shrink-0">
            · {root.author?.login ?? "ghost"}
            {replyCount > 0
              ? ` · ${replyCount.toLocaleString()} ${replyCount === 1 ? "reply" : "replies"}`
              : ""}
          </span>
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <>
          <TimelineComment pr={pr} comment={root} mutations={mutations} showPath={false} />
          {replies.length > 0 ? (
            <div className="ml-3 space-y-2 border-l border-border/60 pl-3">
              {replies.map((reply) => (
                <TimelineComment
                  key={reply.id}
                  pr={pr}
                  comment={reply}
                  mutations={mutations}
                  showPath={false}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {row.hasMoreReplies ? (
        <div className="flex flex-wrap items-baseline gap-2 px-1 text-xs text-muted-foreground">
          <span>More replies</span>
          {row.url ? (
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              View on host
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Thread pages the timeline walks for grouping; later threads keep plain time order. */
const TIMELINE_THREAD_PAGES = 10;

/**
 * Thread membership and resolution come from the review threads read. Until it answers, or when
 * it fails, review comments stay in plain time order. Every thread page is read, and threads the
 * read cut short are completed, so a long thread's late replies still group and fold with it.
 */
function useTimelineReviewThreads(pr: TrackedPullRequest, active: boolean) {
  const query = useInfiniteQuery({ ...prHubReviewThreadsQueryOptions(pr.key), enabled: active });
  const pageCount = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (
      active &&
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isFetchNextPageError &&
      pageCount < TIMELINE_THREAD_PAGES
    )
      void query.fetchNextPage();
  }, [active, pageCount, query]);
  const threads = query.data?.pages.flatMap((page) => page.threads) ?? [];
  const partial = threads.filter((thread) => thread.commentsPageInfo?.hasNextPage);
  const completions = useQueries({
    queries: partial.map((thread) => ({
      ...prHubReviewThreadCommentsQueryOptions(pr.key, thread.id),
      enabled: active,
    })),
  });
  const completed = new Map(
    partial.flatMap((thread, index) => {
      const data = completions[index]?.data;
      return data && data.comments.length >= thread.comments.length
        ? [[thread.id, data] as const]
        : [];
    }),
  );
  return threads.map((thread): PrHubReviewThread => {
    const full = completed.get(thread.id);
    return full
      ? {
          ...thread,
          comments: full.comments,
          commentsPageInfo: {
            hasNextPage: full.hasNextPage,
            endCursor: null,
            truncated: false,
          },
        }
      : thread;
  });
}

export function PrTimelineTab({
  pr,
  active,
  mutations,
}: {
  pr: TrackedPullRequest;
  active: boolean;
  mutations: ReturnType<typeof usePrDetailMutations>;
}) {
  const [values, setValues] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const update = (key: string, initial: unknown, value: (previous: unknown) => unknown) => {
    setValues((previous) => {
      const before = previous.has(key) ? previous.get(key) : initial;
      const after = value(before);
      return Object.is(before, after) ? previous : new Map(previous).set(key, after);
    });
  };
  const query = useInfiniteQuery({ ...prHubTimelineQueryOptions(pr.key), enabled: active });
  const pages = query.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.entries);
  const warning = pages.find((page) => page.warning)?.warning;
  const truncated = pages.some((page) => page.pageInfo.truncated);
  const rows = groupTimelineReviewThreads(entries, useTimelineReviewThreads(pr, active));

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="tabpanel">
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading timeline…
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="error" role="tabpanel">
        <AlertTriangleIcon />
        <AlertTitle>Timeline unavailable</AlertTitle>
        <AlertDescription>
          <span>
            {query.error instanceof Error
              ? query.error.message
              : "The timeline could not be loaded."}
          </span>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <TimelineState value={{ values, update }}>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
        role="tabpanel"
        aria-label="Timeline"
      >
        {warning ? (
          <Alert variant="warning">
            <AlertTriangleIcon />
            <AlertTitle>Showing a cached timeline</AlertTitle>
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        ) : null}
        {truncated ? (
          <Alert variant="warning">
            <AlertTriangleIcon />
            <AlertTitle>Some review comments are omitted</AlertTitle>
            <AlertDescription>
              Open the pull request on its forge for the complete thread.
            </AlertDescription>
          </Alert>
        ) : null}

        {entries.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No timeline activity.</p>
        ) : (
          <LegendList<PrTimelineRow>
            data={[...rows]}
            keyExtractor={(row) =>
              row.type === "thread"
                ? ["thread", row.id, row.thread.isResolved, row.dismissed].join(":")
                : row.entry.id
            }
            estimatedItemSize={160}
            ItemSeparatorComponent={TimelineSeparator}
            style={{ flex: 1, minHeight: 0 }}
            renderItem={({ item: row }) => {
              if (row.type === "thread") {
                return (
                  <TimelineReviewThread
                    key={`thread:${row.id}:${row.thread.isResolved}:${row.dismissed}`}
                    pr={pr}
                    row={row}
                    mutations={mutations}
                  />
                );
              }
              const entry = row.entry;
              return entry.type === "comment" ? (
                <TimelineComment key={entry.id} pr={pr} comment={entry} mutations={mutations} />
              ) : (
                <article
                  key={entry.id}
                  className="flex items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5"
                >
                  <GitCommitHorizontalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 text-sm">
                    <p className="break-words font-medium">{entry.messageHeadline}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="font-mono">{entry.oid.slice(0, 8)}</span>
                      {entry.authors[0] ? ` · ${entry.authors[0].login}` : ""}
                      {` · ${formatRelativeTimeLabel(entry.committedAt)}`}
                    </p>
                  </div>
                </article>
              );
            }}
          />
        )}

        {query.hasNextPage ? (
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load older activity"}
          </Button>
        ) : null}
      </div>
    </TimelineState>
  );
}
