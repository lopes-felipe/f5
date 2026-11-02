import { describe, expect, it } from "vitest";
import type {
  PrHubReviewThread,
  PrHubTimelineComment,
  PrHubTimelineEntry,
} from "@t3tools/contracts";
import { groupTimelineReviewThreads, type PrTimelineRow } from "./prTimelineThreads";

const comment = (
  id: string,
  createdAt: string,
  kind: PrHubTimelineComment["kind"] = "review-comment",
): PrHubTimelineComment => ({
  type: "comment",
  id,
  databaseId: null,
  kind,
  author: { login: id, name: null, avatarUrl: null },
  body: id,
  createdAt,
  updatedAt: null,
  url: `https://github.com/octo/repo/pull/7#${id}`,
  path: kind === "review-comment" ? "a.ts" : null,
  line: kind === "review-comment" ? 1 : null,
  reviewState: null,
  viewerCanUpdate: false,
  reactions: [],
});

const thread = (
  id: string,
  commentIds: ReadonlyArray<string>,
  extra: Partial<PrHubReviewThread> = {},
): PrHubReviewThread => ({
  id,
  isResolved: false,
  path: "a.ts",
  line: 1,
  originalLine: 1,
  comments: commentIds.map((commentId) => ({
    id: commentId,
    url: `https://github.com/octo/repo/pull/7#${commentId}`,
    author: commentId,
    bodyText: commentId,
    createdAt: null,
    updatedAt: null,
    outdated: false,
    diffHunk: null,
  })),
  ...extra,
});

const shape = (rows: ReadonlyArray<PrTimelineRow>) =>
  rows.map((row) =>
    row.type === "entry"
      ? row.entry.id
      : {
          thread: row.id,
          root: row.root.id,
          replies: row.replies.map((reply) => reply.id),
          moreReplies: row.moreReplies,
          hasMoreReplies: row.hasMoreReplies,
        },
  );

describe("groupTimelineReviewThreads", () => {
  it("keeps later replies with their finding, oldest first, at the finding's place", () => {
    // Newest first, as the timeline arrives.
    const entries: PrHubTimelineEntry[] = [
      comment("reply-2", "2026-10-05T00:00:00Z"),
      comment("issue", "2026-10-04T00:00:00Z", "issue-comment"),
      comment("reply-1", "2026-10-03T00:00:00Z"),
      comment("other", "2026-10-02T00:00:00Z"),
      comment("finding", "2026-10-01T00:00:00Z"),
    ];
    const rows = groupTimelineReviewThreads(entries, [
      thread("T1", ["finding", "reply-1", "reply-2"]),
    ]);
    expect(shape(rows)).toEqual([
      "issue",
      "other",
      {
        thread: "T1",
        root: "finding",
        replies: ["reply-1", "reply-2"],
        moreReplies: 0,
        hasMoreReplies: false,
      },
    ]);
  });

  it("counts thread comments the loaded pages do not reach, and flags unread comment pages", () => {
    const entries: PrHubTimelineEntry[] = [
      comment("reply-2", "2026-10-05T00:00:00Z"),
      comment("reply-1", "2026-10-03T00:00:00Z"),
    ];
    expect(
      shape(groupTimelineReviewThreads(entries, [thread("T1", ["finding", "reply-1", "reply-2"])])),
    ).toEqual([
      {
        thread: "T1",
        root: "reply-1",
        replies: ["reply-2"],
        moreReplies: 1,
        hasMoreReplies: true,
      },
    ]);
    expect(
      shape(
        groupTimelineReviewThreads(
          [comment("finding", "2026-10-01T00:00:00Z")],
          [
            thread("T1", ["finding"], {
              commentsPageInfo: { hasNextPage: true, endCursor: "c", truncated: false },
            }),
          ],
        ),
      ),
    ).toEqual([
      { thread: "T1", root: "finding", replies: [], moreReplies: 0, hasMoreReplies: true },
    ]);
  });

  it("leaves comments of unloaded threads, issue comments and commits where they are", () => {
    const entries: PrHubTimelineEntry[] = [
      {
        type: "commit",
        id: "abc",
        oid: "abc",
        messageHeadline: "Change",
        committedAt: "2026-10-03T00:00:00Z",
        authors: [],
      },
      comment("loose", "2026-10-02T00:00:00Z"),
      comment("issue", "2026-10-01T00:00:00Z", "issue-comment"),
    ];
    expect(shape(groupTimelineReviewThreads(entries, []))).toEqual(["abc", "loose", "issue"]);
  });
});
