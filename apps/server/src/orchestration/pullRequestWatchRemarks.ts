import type {
  PrHubReviewComment,
  PrHubTimelineComment,
  PrHubThreadsPage,
  PullRequestKey,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type { PrHubServiceShape } from "../prHub/Services/PrHubService.ts";
import type { PullRequestComment } from "./pullRequestWatch.ts";

/**
 * Authors whose comment text a watch passes to the agent. Anyone can comment on a public pull
 * request, and a watch wakes the agent without a person in the loop, so other comments are
 * reported by author and link only. A host that does not report the relation trusts no one.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A partial comment read never advances a watch's global remark watermark. */
export function readPullRequestWatchRemarks(input: {
  readonly hub: Pick<PrHubServiceShape, "getTimeline" | "getReviewThreads">;
  readonly key: PullRequestKey;
  readonly accountGeneration: string;
  readonly github: boolean;
}) {
  return Effect.gen(function* () {
    const remarks = new Map<string, PullRequestComment>();
    const seen = new Set<string>();
    let reads = 0;
    const add = (comment: PrHubTimelineComment | PrHubReviewComment, path?: string | null) => {
      const threaded = "bodyText" in comment;
      const createdAt = comment.createdAt;
      if (!comment.id.trim() || !createdAt || !Number.isFinite(Date.parse(createdAt))) return;
      const author = threaded
        ? comment.author
          ? { login: comment.author, name: null, avatarUrl: null }
          : null
        : comment.author;
      remarks.set(comment.id, {
        id: comment.id,
        kind: threaded ? "review-comment" : comment.kind,
        author,
        trusted: TRUSTED_ASSOCIATIONS.has(comment.authorAssociation ?? ""),
        body: (threaded ? comment.bodyText : comment.body).slice(0, 1000),
        createdAt,
        editedAt:
          comment.updatedAt && Number.isFinite(Date.parse(comment.updatedAt))
            ? comment.updatedAt
            : null,
        path: threaded ? (path ?? null) : comment.path,
        reviewState: threaded ? null : comment.reviewState,
        url: comment.url ?? "",
      });
    };
    const target = { key: input.key, accountGeneration: input.accountGeneration };
    let cursor: string | undefined;
    do {
      if (++reads > 32) return null;
      const page = yield* input.hub.getTimeline({
        ...target,
        commentsOnly: true,
        mode: "force",
        ...(cursor ? { cursor } : {}),
      });
      if (page.stale || (!input.github && page.pageInfo.truncated)) return null;
      for (const entry of page.entries) if (entry.type === "comment") add(entry);
      if (remarks.size > 5000) return null;
      if (!page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor || seen.has(`timeline:${page.pageInfo.endCursor}`)) return null;
      cursor = page.pageInfo.endCursor;
      seen.add(`timeline:${cursor}`);
    } while (cursor);
    cursor = undefined;
    do {
      if (++reads > 32) return null;
      const page: PrHubThreadsPage = yield* input.hub.getReviewThreads({
        ...target,
        ...(cursor ? { cursor } : {}),
      });
      if (page.pageInfo.truncated) return null;
      for (const thread of page.threads) {
        for (const comment of thread.comments) add(comment, thread.path);
        let tail = thread.commentsPageInfo;
        if (tail?.truncated) return null;
        while (tail?.hasNextPage) {
          if (++reads > 32 || !tail.endCursor || seen.has(`thread:${thread.id}:${tail.endCursor}`))
            return null;
          seen.add(`thread:${thread.id}:${tail.endCursor}`);
          const next = yield* input.hub.getReviewThreads({
            ...target,
            threadId: thread.id,
            cursor: tail.endCursor,
          });
          const nextThread = next.threads[0];
          if (
            next.pageInfo.truncated ||
            next.threads.length !== 1 ||
            !nextThread ||
            nextThread.id !== thread.id
          )
            return null;
          for (const comment of nextThread.comments) add(comment, thread.path);
          tail = nextThread.commentsPageInfo;
          if (tail?.truncated || (next.pageInfo.hasNextPage && !tail)) return null;
          if (remarks.size > 5000) return null;
        }
      }
      if (remarks.size > 5000) return null;
      if (!page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor || seen.has(`threads:${page.pageInfo.endCursor}`)) return null;
      cursor = page.pageInfo.endCursor;
      seen.add(`threads:${cursor}`);
    } while (cursor);
    return [...remarks.values()];
  });
}
