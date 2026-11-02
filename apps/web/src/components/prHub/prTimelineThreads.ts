import type {
  PrHubReviewThread,
  PrHubTimelineComment,
  PrHubTimelineEntry,
} from "@t3tools/contracts";

export interface PrTimelineThreadRow {
  readonly type: "thread";
  readonly id: string;
  readonly thread: PrHubReviewThread;
  readonly root: PrHubTimelineComment;
  /** Oldest first, so a conversation reads in the order it happened. */
  readonly replies: ReadonlyArray<PrHubTimelineComment>;
  /** Thread comments the loaded timeline pages do not contain yet. */
  readonly moreReplies: number;
  readonly hasMoreReplies: boolean;
  readonly url: string | null;
}

export type PrTimelineRow =
  | { readonly type: "entry"; readonly entry: PrHubTimelineEntry }
  | PrTimelineThreadRow;

const instant = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Keeps review-thread replies with their finding. A thread takes the place of its oldest loaded
 * comment, so later replies — often submitted in another review — no longer scatter across the
 * timeline. Comments of threads that are not loaded stay where they are.
 */
export function groupTimelineReviewThreads(
  entries: ReadonlyArray<PrHubTimelineEntry>,
  threads: ReadonlyArray<PrHubReviewThread>,
): ReadonlyArray<PrTimelineRow> {
  const threadByCommentId = new Map<string, PrHubReviewThread>();
  for (const thread of threads) {
    for (const comment of thread.comments) threadByCommentId.set(comment.id, thread);
  }
  const membersByThread = new Map<string, PrHubTimelineComment[]>();
  const claimed = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "comment" || entry.kind !== "review-comment" || claimed.has(entry.id))
      continue;
    const thread = threadByCommentId.get(entry.id);
    if (!thread) continue;
    claimed.add(entry.id);
    const members = membersByThread.get(thread.id) ?? [];
    members.push(entry);
    membersByThread.set(thread.id, members);
  }
  const threadRows = new Map<string, PrTimelineThreadRow>();
  for (const thread of threads) {
    const members = membersByThread.get(thread.id);
    if (!members) continue;
    const ordered = members.toSorted(
      (left, right) => instant(left.createdAt) - instant(right.createdAt),
    );
    const [root, ...replies] = ordered;
    if (!root) continue;
    const moreReplies = Math.max(0, thread.comments.length - ordered.length);
    threadRows.set(root.id, {
      type: "thread",
      id: thread.id,
      thread,
      root,
      replies,
      moreReplies,
      hasMoreReplies: moreReplies > 0 || thread.commentsPageInfo?.hasNextPage === true,
      url: ordered.find((comment) => comment.url !== null)?.url ?? thread.comments[0]?.url ?? null,
    });
  }
  const rows: PrTimelineRow[] = [];
  for (const entry of entries) {
    const threadRow = entry.type === "comment" ? threadRows.get(entry.id) : undefined;
    if (threadRow) {
      rows.push(threadRow);
      threadRows.delete(entry.id);
      continue;
    }
    if (entry.type === "comment" && entry.kind === "review-comment" && claimed.has(entry.id))
      continue;
    rows.push({ type: "entry", entry });
  }
  return rows;
}
