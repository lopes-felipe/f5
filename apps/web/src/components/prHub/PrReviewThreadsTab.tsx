import { PrThreadReply } from "./PrThreadReply";
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { PrHubReviewThread, TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Button } from "../ui/button";

export function PrReviewThreadsTab({ pr }: { pr: TrackedPullRequest }) {
  const accountGeneration = getPrHubAccountGeneration();
  const query = useInfiniteQuery({
    queryKey: ["prHub", "reviewThreads", accountGeneration, pr.key],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().prHub.getReviewThreads({
        key: pr.key,
        accountGeneration,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
  });
  return (
    <div role="tabpanel" aria-label="Review threads" className="space-y-3">
      {query.isPending ? <p>Loading review threads…</p> : null}
      {query.isError ? (
        <p role="alert">
          {query.error.message}{" "}
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Reload threads
          </Button>
        </p>
      ) : null}
      {query.data?.pages.flatMap((page) =>
        page.threads.map((thread) => (
          <Thread
            key={`${accountGeneration}:${pr.key}:${thread.id}`}
            pr={pr}
            thread={thread}
            comparisonVersion={page.comparisonVersion}
          />
        )),
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh threads
      </Button>
      {query.data?.pages[0]?.threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No review threads.</p>
      ) : null}
      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more threads
        </Button>
      ) : null}
    </div>
  );
}

function Thread({
  pr,
  thread,
  comparisonVersion,
}: {
  pr: TrackedPullRequest;
  thread: PrHubReviewThread;
  comparisonVersion: string;
}) {
  const accountGeneration = getPrHubAccountGeneration();
  const queryClient = useQueryClient();
  const [replyOpen, setReplyOpen] = useState(false);
  const [loadComments, setLoadComments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["prHub", "reviewThreads", accountGeneration, pr.key, thread.id],
    enabled: loadComments,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().prHub.getReviewThreads({
        key: pr.key,
        accountGeneration,
        threadId: thread.id,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
  });
  const comments = query.data
    ? query.data.pages.flatMap((page) => page.threads.flatMap((thread) => thread.comments))
    : thread.comments;
  async function setResolved() {
    setBusy(true);
    setError(null);
    try {
      await ensureNativeApi().prHub.setReviewThreadState({
        key: pr.key,
        accountGeneration,
        threadId: thread.id,
        resolved: !thread.isResolved,
      });
      await queryClient.invalidateQueries({
        queryKey: ["prHub", "reviewThreads", accountGeneration, pr.key],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Thread update failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2 rounded border border-border p-3">
      <p className="text-sm font-medium">
        <code>
          {thread.path}:{thread.line ?? thread.originalLine ?? "file"}
        </code>{" "}
        · {thread.isResolved ? "Resolved" : "Unresolved"}
        {thread.isOutdated ? " · Outdated" : ""}
      </p>
      {comments.map((comment) => (
        <div key={comment.id} className="border-l-2 border-border pl-3">
          <a
            href={comment.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground"
          >
            @{comment.author ?? "unknown"}
          </a>
          <p className="whitespace-pre-wrap text-sm">{comment.bodyText}</p>
        </div>
      ))}
      {error || query.error ? (
        <p role="alert" className="text-sm">
          {error ?? query.error?.message}
        </p>
      ) : null}
      {!loadComments && thread.commentsPageInfo?.hasNextPage ? (
        <Button size="xs" variant="outline" onClick={() => setLoadComments(true)}>
          Load more comments
        </Button>
      ) : null}
      {query.hasNextPage ? (
        <Button
          size="xs"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more comments
        </Button>
      ) : null}
      {!pr.repositoryArchived &&
      (thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void setResolved()}>
          {thread.isResolved ? "Reopen conversation" : "Resolve conversation"}
        </Button>
      ) : null}
      {!pr.repositoryArchived && thread.viewerCanReply ? (
        <Button size="xs" variant="outline" onClick={() => setReplyOpen(!replyOpen)}>
          Reply
        </Button>
      ) : null}
      {replyOpen ? (
        <PrThreadReply prKey={pr.key} threadId={thread.id} comparisonVersion={comparisonVersion} />
      ) : null}
    </section>
  );
}
