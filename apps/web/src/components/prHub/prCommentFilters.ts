import type { PrHubReviewComment, PrHubReviewThread } from "@t3tools/contracts";

export interface PrCommentFilters {
  readonly bots: boolean;
  readonly resolved: boolean;
}
export const isBotReviewComment = (comment: Pick<PrHubReviewComment, "author" | "authorIsBot">) =>
  comment.authorIsBot === true || /\[bot\]$/i.test(comment.author ?? "");

/** Incomplete comment pages can contain human replies: keep their pagination reachable. */
export function visibleReviewThreads(
  threads: ReadonlyArray<PrHubReviewThread>,
  filters: PrCommentFilters,
) {
  return threads.filter(
    (thread) =>
      (filters.resolved || !thread.isResolved) &&
      (filters.bots ||
        thread.comments.length === 0 ||
        thread.commentsPageInfo?.hasNextPage ||
        thread.comments.some((comment) => !isBotReviewComment(comment))),
  );
}
