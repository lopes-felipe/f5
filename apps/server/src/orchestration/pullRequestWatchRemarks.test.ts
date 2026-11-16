import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
  PullRequestKey,
  type PrHubReviewComment,
  type PrHubReviewThread,
  type PrHubThreadsPage,
  type PrHubTimelineComment,
  type PrHubTimelinePage,
} from "@t3tools/contracts";
import { readPullRequestWatchRemarks } from "./pullRequestWatchRemarks.ts";

const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#1");
const time = "2026-10-19T12:00:00.000Z";
const pageInfo = { hasNextPage: false, endCursor: null, truncated: false };
const comment = (id: string): PrHubReviewComment => ({
  id,
  url: "https://github.com/org/repo/pull/1",
  author: "bot",
  bodyText: `Reply ${id}`,
  createdAt: time,
  updatedAt: time,
  outdated: false,
  diffHunk: null,
});
const thread = (overrides: Partial<PrHubReviewThread> = {}): PrHubReviewThread => ({
  id: "thread",
  isResolved: true,
  isOutdated: true,
  path: "a.ts",
  line: 1,
  originalLine: 1,
  comments: [comment("first")],
  commentsPageInfo: pageInfo,
  ...overrides,
});
const threads = (values: ReadonlyArray<PrHubReviewThread>): PrHubThreadsPage => ({
  threads: values,
  pageInfo,
  comparisonVersion: "head:base",
  refreshedAt: time,
});
const timeline: PrHubTimelinePage = { entries: [], pageInfo, stale: false, refreshedAt: time };

it("finishes paginated replies, including resolved/outdated threads, before returning complete remarks", async () => {
  const getTimeline = vi.fn(() =>
    Effect.succeed({ ...timeline, pageInfo: { ...pageInfo, truncated: true } }),
  );
  const getReviewThreads = vi.fn((input: { threadId?: string | undefined }) =>
    Effect.succeed(
      input.threadId
        ? threads([thread({ comments: [comment("late-reply")] })])
        : threads([
            thread({ commentsPageInfo: { ...pageInfo, hasNextPage: true, endCursor: "tail" } }),
          ]),
    ),
  );
  const result = await Effect.runPromise(
    readPullRequestWatchRemarks({
      key,
      accountGeneration: "one",
      github: true,
      hub: { getTimeline, getReviewThreads },
    }),
  );
  expect(result?.map((comment) => comment.id)).toEqual(["first", "late-reply"]);
  expect(getReviewThreads).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "thread", cursor: "tail" }),
  );
  expect(getTimeline).toHaveBeenCalledWith(expect.objectContaining({ commentsOnly: true }));
});
it("does not advance past an incomplete thread tail or repeated continuation cursor", async () => {
  const getReviewThreads = () =>
    Effect.succeed(
      threads([
        thread({ commentsPageInfo: { ...pageInfo, hasNextPage: true, endCursor: "repeated" } }),
      ]),
    );
  expect(
    await Effect.runPromise(
      readPullRequestWatchRemarks({
        key,
        accountGeneration: "one",
        github: true,
        hub: { getTimeline: () => Effect.succeed(timeline), getReviewThreads },
      }),
    ),
  ).toBeNull();
});
it("retains edit times and bounds the text kept for a watch message", async () => {
  const editedAt = "2026-10-19T12:01:00.000Z";
  const entry: PrHubTimelineComment = {
    type: "comment",
    id: "edited",
    databaseId: null,
    kind: "issue-comment",
    author: { login: "bot", name: null, avatarUrl: null },
    body: "x".repeat(20_000),
    createdAt: time,
    updatedAt: editedAt,
    url: "https://github.com/org/repo/pull/1",
    path: null,
    line: null,
    reviewState: null,
    viewerCanUpdate: false,
    reactions: [],
  };
  const result = await Effect.runPromise(
    readPullRequestWatchRemarks({
      key,
      accountGeneration: "one",
      github: true,
      hub: {
        getTimeline: () => Effect.succeed({ ...timeline, entries: [entry] }),
        getReviewThreads: () => Effect.succeed(threads([])),
      },
    }),
  );
  expect(result?.[0]?.editedAt).toBe(editedAt);
  expect(result?.[0]?.body).toHaveLength(1000);
});

it("trusts only comments from the repository's owner, members and collaborators", async () => {
  const result = await Effect.runPromise(
    readPullRequestWatchRemarks({
      key,
      accountGeneration: "one",
      github: true,
      hub: {
        getTimeline: () => Effect.succeed(timeline),
        getReviewThreads: () =>
          Effect.succeed(
            threads([
              thread({
                comments: [
                  { ...comment("owner"), authorAssociation: "OWNER" },
                  { ...comment("collaborator"), authorAssociation: "COLLABORATOR" },
                  { ...comment("contributor"), authorAssociation: "CONTRIBUTOR" },
                  { ...comment("stranger"), authorAssociation: "NONE" },
                  comment("unknown"),
                ],
              }),
            ]),
          ),
      },
    }),
  );
  expect(Object.fromEntries(result!.map((remark) => [remark.id, remark.trusted]))).toEqual({
    owner: true,
    collaborator: true,
    contributor: false,
    stranger: false,
    unknown: false,
  });
});
it("keeps the watermark when another forge reports a truncated activity list", async () => {
  const getReviewThreads = vi.fn(() => Effect.succeed(threads([])));
  const result = await Effect.runPromise(
    readPullRequestWatchRemarks({
      key,
      accountGeneration: "one",
      github: false,
      hub: {
        getTimeline: () =>
          Effect.succeed({ ...timeline, pageInfo: { ...pageInfo, truncated: true } }),
        getReviewThreads,
      },
    }),
  );
  expect(result).toBeNull();
  expect(getReviewThreads).not.toHaveBeenCalled();
});
