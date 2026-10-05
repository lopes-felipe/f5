import { ForgeReactionControl } from "./ForgeReactionControl";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { PrSendToAgent } from "./PrSendToAgent";
import { PrMarkdown } from "./PrMarkdown";
import { PrAuthorLink } from "./PrAuthorLink";
import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PencilIcon,
} from "lucide-react";
import type { PrHubTimelineComment, TrackedPullRequest } from "@t3tools/contracts";

import { prHubTimelineQueryOptions } from "../../lib/prHubReactQuery";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PrReactionBar } from "./PrReactionBar";
import { prDetailCapability } from "./prDetails.logic";
import type { usePrDetailMutations } from "./usePrDetailMutations";

function TimelineComment({
  pr,
  comment,
  mutations,
}: {
  pr: TrackedPullRequest;
  comment: PrHubTimelineComment;
  mutations: ReturnType<typeof usePrDetailMutations>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
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
      {comment.path ? (
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
        <PrMarkdown body={comment.body} host={pr.host} />
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

export function PrTimelineTab({
  pr,
  active,
  mutations,
}: {
  pr: TrackedPullRequest;
  active: boolean;
  mutations: ReturnType<typeof usePrDetailMutations>;
}) {
  const query = useInfiniteQuery({ ...prHubTimelineQueryOptions(pr.key), enabled: active });
  const pages = query.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.entries);
  const warning = pages.find((page) => page.warning)?.warning;
  const truncated = pages.some((page) => page.pageInfo.truncated);

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
    <div className="space-y-3" role="tabpanel" aria-label="Timeline">
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
        entries.map((entry) =>
          entry.type === "comment" ? (
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
          ),
        )
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
  );
}
