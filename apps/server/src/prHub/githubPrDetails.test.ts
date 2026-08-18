import { describe, expect, it } from "vitest";
import { PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";

import {
  decodeGitHubPrDetail,
  decodeGitHubPrFiles,
  decodeGitHubPrTimeline,
  githubTimelineVariables,
} from "./githubPrDetails.ts";

function trackedPr(): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#7"),
    provider: "github",
    nodeId: "PR_7",
    number: 7,
    title: "Tracked title",
    url: "https://github.com/octo/repo/pull/7",
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "octocat",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "awaiting_review",
    attentionBucket: "waiting_on_others",
    primaryReason: "Waiting",
    nextAction: "Wait",
    checkRollup: "pending",
    reviewDecision: "review_required",
    mergeable: "unknown",
    mergeStateStatus: "UNKNOWN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: null,
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fingerprint",
  };
}

function responseWithPullRequest(pullRequest: Record<string, unknown>) {
  return {
    data: {
      repository: { pullRequest },
      rateLimit: { remaining: 42, limit: 5_000, resetAt: "2026-01-03T00:00:00.000Z" },
    },
  };
}

describe("GitHub PR detail decoding", () => {
  it("rejects partial GraphQL responses instead of treating missing fields as authoritative", () => {
    expect(() =>
      decodeGitHubPrDetail(
        {
          ...responseWithPullRequest({ id: "PR_graphql" }),
          errors: [{ message: "statusCheckRollup failed" }],
        },
        trackedPr(),
      ),
    ).toThrow("GraphQL errors");
  });

  it("normalizes detail, reviewer, check, and reaction fields", () => {
    const result = decodeGitHubPrDetail(
      responseWithPullRequest({
        id: "PR_graphql",
        title: "GraphQL title",
        body: "Description",
        url: "https://github.com/octo/repo/pull/7",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "head",
        baseRefOid: "base",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        mergedAt: null,
        closedAt: null,
        viewerCanUpdate: true,
        viewerDidAuthor: true,
        author: { login: "octocat", name: "Octo Cat", avatarUrl: "https://example.test/a" },
        labels: { nodes: [{ name: "feature", color: "00ff00" }] },
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: "User", login: "alice" } },
            { requestedReviewer: { __typename: "Team", slug: "platform" } },
          ],
        },
        latestReviews: { nodes: [{ author: { login: "bob" } }] },
        reactionGroups: [
          {
            content: "EYES",
            viewerHasReacted: true,
            users: { totalCount: 2, nodes: [{ login: "me" }, { login: "alice" }] },
          },
        ],
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        detailsUrl: "https://example.test/build",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      trackedPr(),
    );

    expect(result.detail.title).toBe("GraphQL title");
    expect(result.detail.reviewers.map((reviewer) => reviewer.login)).toEqual([
      "bob",
      "alice",
      "platform",
    ]);
    expect(result.detail.checks).toEqual([
      {
        name: "build",
        status: "success",
        description: "SUCCESS",
        url: "https://example.test/build",
      },
    ]);
    expect(result.detail.reactions[0]).toMatchObject({
      content: "eyes",
      count: 2,
      viewerHasReacted: true,
    });
    expect(result.rateLimit?.remaining).toBe(42);
  });

  it("reports truncated summary connections and keeps users and teams distinct", () => {
    const result = decodeGitHubPrDetail(
      responseWithPullRequest({
        ...trackedPr(),
        id: "PR_graphql",
        labels: { totalCount: 51, pageInfo: { hasNextPage: true }, nodes: [] },
        reviewRequests: {
          totalCount: 1,
          pageInfo: { hasNextPage: false },
          nodes: [{ requestedReviewer: { __typename: "Team", slug: "platform" } }],
        },
        latestReviews: {
          totalCount: 1,
          pageInfo: { hasNextPage: false },
          nodes: [{ author: { login: "platform" } }],
        },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    totalCount: 101,
                    pageInfo: { hasNextPage: true },
                    nodes: [],
                  },
                },
              },
            },
          ],
        },
      }),
      trackedPr(),
    );

    expect(result.detail.truncatedSections).toEqual(["labels", "checks"]);
    expect(result.detail.reviewers.map((reviewer) => reviewer.kind)).toEqual(["user", "team"]);
  });

  it("builds a stable multi-stream cursor and reports nested truncation", () => {
    const page = decodeGitHubPrTimeline(
      responseWithPullRequest({
        comments: {
          nodes: [
            {
              id: "IC_1",
              databaseId: 11,
              body: "Issue comment",
              createdAt: "2026-01-03T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
              viewerDidAuthor: true,
              author: { login: "me" },
              reactionGroups: [],
            },
          ],
          pageInfo: { hasPreviousPage: true, startCursor: "issue-before" },
        },
        reviews: {
          nodes: [
            {
              id: "R_1",
              body: "Approved",
              state: "APPROVED",
              submittedAt: "2026-01-02T00:00:00.000Z",
              author: { login: "alice" },
              comments: {
                totalCount: 2,
                nodes: [
                  {
                    id: "RC_1",
                    databaseId: 12,
                    body: "Nit",
                    createdAt: "2026-01-02T01:00:00.000Z",
                    viewerDidAuthor: false,
                    author: { login: "alice" },
                    path: "src/a.ts",
                    line: 9,
                    reactionGroups: [],
                  },
                ],
              },
            },
          ],
          pageInfo: { hasPreviousPage: false, startCursor: "review-before" },
        },
        commits: {
          nodes: [
            {
              commit: {
                oid: "abcdef123456",
                messageHeadline: "Initial commit",
                committedDate: "2026-01-01T00:00:00.000Z",
                authors: { nodes: [{ name: "Octo", user: { login: "octocat" } }] },
              },
            },
          ],
          pageInfo: { hasPreviousPage: false, startCursor: "commit-before" },
        },
      }),
    );

    expect(page.entries.map((entry) => entry.id)).toEqual(["IC_1", "RC_1", "R_1", "abcdef123456"]);
    expect(page.pageInfo.truncated).toBe(true);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(page.pageInfo.endCursor).not.toBeNull();
    expect(
      githubTimelineVariables({
        owner: "octo",
        repo: "repo",
        number: 7,
        cursor: page.pageInfo.endCursor ?? undefined,
      }),
    ).toMatchObject({
      issueCursor: "issue-before",
      issueLimit: 25,
      reviewLimit: 1,
      commitLimit: 1,
    });
  });

  it("normalizes file change pages and their pagination cursor", () => {
    const page = decodeGitHubPrFiles(
      responseWithPullRequest({
        files: {
          nodes: [
            { path: "src/new.ts", additions: 10, deletions: 0, changeType: "ADDED" },
            { path: "src/old.ts", additions: 0, deletions: 4, changeType: "DELETED" },
          ],
          pageInfo: { hasNextPage: true, endCursor: "files-next" },
        },
      }),
    );

    expect(page.files.map((file) => file.changeType)).toEqual(["added", "deleted"]);
    expect(page.pageInfo).toMatchObject({ hasNextPage: true, endCursor: "files-next" });
  });

  it("rejects malformed timeline cursors", () => {
    expect(() =>
      githubTimelineVariables({ owner: "octo", repo: "repo", number: 7, cursor: "not-base64" }),
    ).toThrow();
  });
});
