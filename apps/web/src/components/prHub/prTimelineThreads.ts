import type {
  PrHubReviewComment,
  PrHubReviewThread,
  PrHubTimelineComment,
  PrHubTimelineEntry,
} from "@t3tools/contracts";

export interface PrTimelineThreadRow {
  readonly type: "thread";
  readonly id: string;
  readonly thread: PrHubReviewThread;
  /** The thread's first comment, its finding, even when the timeline has not loaded it yet. */
  readonly root: PrHubTimelineComment;
  /** In the thread's own order, so a conversation reads in the order it happened. */
  readonly replies: ReadonlyArray<PrHubTimelineComment>;
  /** The finding's review was dismissed; like a resolved thread, it folds as a unit. */
  readonly dismissed: boolean;
  /** The thread has comments the review threads read did not reach. */
  readonly hasMoreReplies: boolean;
  readonly url: string | null;
}

export type PrTimelineRow =
  | { readonly type: "entry"; readonly entry: PrHubTimelineEntry }
  | PrTimelineThreadRow;

/** A thread comment the loaded timeline pages do not contain, rendered from the thread's copy. */
function threadCommentEntry(
  thread: PrHubReviewThread,
  comment: PrHubReviewComment,
  fallbackCreatedAt: string,
): PrHubTimelineComment {
  return {
    type: "comment",
    id: comment.id,
    databaseId: null,
    kind: "review-comment",
    author: comment.author ? { login: comment.author, name: null, avatarUrl: null } : null,
    ...(comment.authorAssociation ? { authorAssociation: comment.authorAssociation } : {}),
    body: comment.body ?? comment.bodyText,
    createdAt: comment.createdAt ?? fallbackCreatedAt,
    updatedAt: comment.updatedAt,
    url: comment.url || null,
    path: thread.path,
    line: thread.line ?? thread.originalLine,
    reviewState: null,
    viewerCanUpdate: false,
    reactions: [],
  };
}

/**
 * Keeps review-thread replies with their finding. A thread takes the place of its oldest loaded
 * comment, so later replies — often submitted in another review — no longer scatter across the
 * timeline. Comments the timeline has not loaded come from the thread itself, so the finding is
 * always the root. Comments of threads that are not loaded stay where they are.
 */
export function groupTimelineReviewThreads(
  entries: ReadonlyArray<PrHubTimelineEntry>,
  threads: ReadonlyArray<PrHubReviewThread>,
): ReadonlyArray<PrTimelineRow> {
  const threadByCommentId = new Map<string, PrHubReviewThread>();
  for (const thread of threads) {
    for (const comment of thread.comments) threadByCommentId.set(comment.id, thread);
  }
  const loaded = new Map<string, PrHubTimelineComment>();
  // Entries arrive newest first, so the last member seen is the thread's oldest loaded comment.
  const anchorByThread = new Map<string, PrHubTimelineComment>();
  for (const entry of entries) {
    if (entry.type !== "comment" || entry.kind !== "review-comment" || loaded.has(entry.id))
      continue;
    const thread = threadByCommentId.get(entry.id);
    if (!thread) continue;
    loaded.set(entry.id, entry);
    anchorByThread.set(thread.id, entry);
  }
  const rowByAnchor = new Map<string, PrTimelineThreadRow>();
  for (const thread of threads) {
    const anchor = anchorByThread.get(thread.id);
    if (!anchor) continue;
    const [root, ...replies] = thread.comments.map(
      (comment) => loaded.get(comment.id) ?? threadCommentEntry(thread, comment, anchor.createdAt),
    );
    if (!root) continue;
    rowByAnchor.set(anchor.id, {
      type: "thread",
      id: thread.id,
      thread,
      root,
      replies,
      dismissed: root.reviewState?.toUpperCase() === "DISMISSED",
      hasMoreReplies: thread.commentsPageInfo?.hasNextPage === true,
      url: [root, ...replies].find((comment) => comment.url !== null)?.url ?? null,
    });
  }
  const rows: PrTimelineRow[] = [];
  for (const entry of entries) {
    const threadRow = rowByAnchor.get(entry.id);
    if (threadRow) {
      rows.push(threadRow);
      rowByAnchor.delete(entry.id);
      continue;
    }
    if (entry.type === "comment" && entry.kind === "review-comment" && loaded.has(entry.id))
      continue;
    rows.push({ type: "entry", entry });
  }
  return rows;
}
