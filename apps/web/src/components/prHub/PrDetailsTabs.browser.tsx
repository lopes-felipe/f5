import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  NativeApi,
  PrHubDetailMutationResult,
  PrHubDetailResult,
  PrHubFilesPage,
  PrHubReviewDraft,
  PrHubReplyDraft,
  PrHubReviewOperation,
  PrHubTimelinePage,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PrDetailsTabs } from "./PrDetailsTabs";

const nativeApiRef = vi.hoisted(() => ({
  current: undefined as NativeApi | undefined,
  updateComment: vi.fn(),
  setReaction: vi.fn(),
  changeReviewers: vi.fn(),
  updateBranch: vi.fn(),
  submitReview: vi.fn(),
  prepareReview: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) throw new Error("Native API not found");
    return nativeApiRef.current;
  },
}));

const KEY = PullRequestKey.makeUnsafe("github:github.com/octo/repo#1");

function makePr(): TrackedPullRequest {
  return {
    key: KEY,
    provider: "github",
    capabilities: [
      { action: "react", supported: true },
      { action: "edit-comment", supported: true },
      { action: "change-reviewers", supported: true },
      { action: "update-branch", supported: true },
    ],
    nodeId: "PR_1",
    number: 1,
    title: "PR details",
    url: "https://github.com/octo/repo/pull/1",
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "awaiting_review",
    attentionBucket: "waiting_on_others",
    primaryReason: "Waiting",
    nextAction: "Wait",
    checkRollup: "success",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: ["alice"],
    reviewRequestsCount: 1,
    commentsCount: 1,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 2,
    deletions: 1,
    changedFiles: 1,
    headRefOid: "head",
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

function detailResult(): PrHubDetailResult {
  return {
    detail: {
      key: KEY,
      providerDetails: {
        provider: "github",
        nodeId: "PR_1",
        mergeStateStatus: "CLEAN",
        headRefOid: "head",
        baseRefOid: "base",
        viewerCanUpdate: true,
        viewerDidAuthor: true,
      },
      title: "PR details",
      body: "Detailed description",
      url: "https://github.com/octo/repo/pull/1",
      state: "open",
      isDraft: false,
      mergeable: "mergeable",
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      headRefName: "feature",
      baseRefName: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      author: { login: "me", name: null, avatarUrl: null },
      labels: [],
      reviewers: [
        {
          login: "alice",
          name: null,
          avatarUrl: null,
          kind: "user",
          requested: true,
        },
      ],
      checks: [{ name: "build", status: "success", description: null, url: null }],
      reactions: [],
    },
    stale: false,
    refreshedAt: "2026-01-02T00:00:00.000Z",
  };
}

function timelinePage(body = "Original comment"): PrHubTimelinePage {
  return {
    entries: [
      {
        type: "comment",
        id: "IC_1",
        databaseId: "11",
        kind: "issue-comment",
        author: { login: "me", name: null, avatarUrl: null },
        body,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        url: null,
        path: null,
        line: null,
        reviewState: null,
        viewerCanUpdate: true,
        reactions: [],
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
    stale: false,
    refreshedAt: "2026-01-02T00:00:00.000Z",
  };
}

function filesPage(): PrHubFilesPage {
  return {
    comparison: {
      baseRepository: "octo/repo",
      baseRef: "main",
      baseOid: "base",
      headRepository: "octo/repo",
      headRef: "feature",
      headOid: "head",
      mergeBaseOid: "base",
      mode: "current_pr",
    },
    files: [
      {
        path: "src/detail.ts",
        additions: 2,
        deletions: 1,
        changeType: "changed",
        patchStatus: "available",
        patch:
          "diff --git a/src/detail.ts b/src/detail.ts\n--- a/src/detail.ts\n+++ b/src/detail.ts\n@@ -1 +1,2 @@\n-oldValue\n+newValue\n+secondValue\n",
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
    stale: false,
    refreshedAt: "2026-01-02T00:00:00.000Z",
  };
}

let savedDraft: PrHubReviewDraft | null = null;
let savedOperation: PrHubReviewOperation | null = null;

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
  nativeApiRef.current = undefined;
  vi.clearAllMocks();
  savedDraft = null;
  savedOperation = null;
});

async function renderTabs() {
  const detail = detailResult();
  const timeline = timelinePage();
  const mutationResult: PrHubDetailMutationResult = { detail, timeline };
  nativeApiRef.updateComment.mockResolvedValue(mutationResult);
  nativeApiRef.setReaction.mockResolvedValue(mutationResult);
  nativeApiRef.changeReviewers.mockResolvedValue(mutationResult);
  nativeApiRef.updateBranch.mockResolvedValue(mutationResult);
  nativeApiRef.prepareReview.mockImplementation((input) => {
    if (!savedDraft) throw new Error("No draft");
    savedOperation = {
      id: input.id,
      status: "prepared",
      remoteId: null,
      payloadHash: "hash",
      correlationNonce: "nonce",
      payload: {
        draft: savedDraft,
        event: input.event,
        body: `${savedDraft.content.body}\n\n<!-- F5 review nonce -->`,
      },
    };
    savedDraft = { ...savedDraft, frozen: true };
    return Promise.resolve(savedOperation);
  });
  nativeApiRef.submitReview.mockImplementation(() => {
    if (!savedOperation || !savedDraft) throw new Error("No preview");
    savedOperation = { ...savedOperation, status: "succeeded", remoteId: "123" };
    savedDraft = {
      ...savedDraft,
      frozen: false,
      version: savedDraft.version + 1,
      content: { ...savedDraft.content, body: "", comments: [] },
    };
    return Promise.resolve(savedOperation);
  });
  nativeApiRef.current = {
    prHub: {
      getDetail: vi.fn().mockResolvedValue(detail),
      getTimeline: vi.fn().mockResolvedValue(timeline),
      getFiles: vi.fn().mockResolvedValue(filesPage()),
      getReviewOperation: vi.fn().mockImplementation(() => Promise.resolve(savedOperation)),
      prepareReview: nativeApiRef.prepareReview,
      submitReview: nativeApiRef.submitReview,
      cancelReviewPreparation: vi.fn(),
      getReviewDraft: vi
        .fn()
        .mockImplementation(() => Promise.resolve({ status: "ok", draft: savedDraft })),
      saveReviewDraft: vi.fn().mockImplementation((input) => {
        savedDraft = {
          version: input.expectedVersion + 1,
          comparison: input.comparison,
          content: input.content,
          updatedAt: new Date().toISOString(),
          frozen: false,
        };
        return Promise.resolve({ status: "ok", draft: savedDraft });
      }),
      updateComment: nativeApiRef.updateComment,
      setReaction: nativeApiRef.setReaction,
      changeReviewers: nativeApiRef.changeReviewers,
      updateBranch: nativeApiRef.updateBranch,
    },
  } as unknown as NativeApi;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  active = await render(
    <QueryClientProvider client={queryClient}>
      <PrDetailsTabs pr={makePr()} summary={<p>Snapshot summary</p>} />
    </QueryClientProvider>,
  );
}

describe("PrDetailsTabs", () => {
  it("loads summary, timeline, and file detail without leaving the PR surface", async () => {
    await renderTabs();
    await expect.element(page.getByText("Detailed description")).toBeInTheDocument();
    await expect.element(page.getByText("build")).toBeInTheDocument();

    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect.element(page.getByText("Original comment")).toBeInTheDocument();

    await page.getByRole("tab", { name: "Files (1)" }).click();
    await expect.element(page.getByRole("button", { name: /src\/detail.ts/ })).toBeInTheDocument();
    await page.getByRole("button", { name: /src\/detail.ts/ }).click();
    await expect.element(page.getByText("secondValue", { exact: true })).toBeInTheDocument();
    await page.getByText("2", { exact: true }).click();
    const inline = page.getByRole("textbox", { name: "src/detail.ts:2 (new)" });
    await userEvent.type(inline, "Why is this needed?");
    await expect.element(page.getByText("Draft saved in F5")).toBeInTheDocument();
    expect(savedDraft?.content.comments).toEqual([
      expect.objectContaining({
        path: "src/detail.ts",
        side: "RIGHT",
        line: 2,
        commitOid: "head",
        body: "Why is this needed?",
      }),
    ]);
  });

  it("autosaves review notes and restores them when the PR is reopened", async () => {
    await renderTabs();
    await page.getByRole("tab", { name: "Files (1)" }).click();
    const editor = page.getByRole("textbox", { name: "Review draft" });
    await userEvent.type(editor, "Please explain the new behavior.");
    await expect.element(page.getByText("Draft saved in F5")).toBeInTheDocument();
    await active?.unmount();
    active = undefined;
    await renderTabs();
    await page.getByRole("tab", { name: "Files (1)" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Review draft" }))
      .toHaveValue("Please explain the new behavior.");
  });

  it("preserves stale comments until each anchor is explicitly revalidated", async () => {
    const comparison = filesPage().comparison!;
    savedDraft = {
      version: 1,
      comparison: { ...comparison, headOid: "old-head" },
      frozen: false,
      updatedAt: new Date().toISOString(),
      content: {
        body: "Preserve my review",
        viewedFiles: [],
        comments: [
          {
            id: "stale-comment",
            path: "src/detail.ts",
            side: "RIGHT",
            line: 2,
            commitOid: "old-head",
            body: "Preserve this feedback",
          },
        ],
      },
    };
    await renderTabs();
    await page.getByRole("tab", { name: "Files (1)" }).click();
    const revalidate = page.getByRole("button", {
      name: "Revalidate draft against current comparison",
    });
    await expect.element(revalidate).toBeDisabled();
    await expect
      .element(page.getByRole("textbox", { name: "src/detail.ts:2 (new)" }))
      .toHaveValue("Preserve this feedback");
    await page
      .getByRole("checkbox", { name: "I checked this anchor against the current diff" })
      .click();
    await revalidate.click();
    await expect.element(revalidate).not.toBeInTheDocument();
    expect(savedDraft?.comparison.headOid).toBe("head");
    expect(savedDraft?.content.comments[0]?.body).toBe("Preserve this feedback");
    expect(nativeApiRef.submitReview).not.toHaveBeenCalled();
  });

  it("requires a marked preview and an explicit submit click before publishing", async () => {
    await renderTabs();
    await page.getByRole("tab", { name: "Files (1)" }).click();
    await userEvent.type(page.getByRole("textbox", { name: "Review draft" }), "Looks good.");
    await expect.element(page.getByText("Draft saved in F5")).toBeInTheDocument();
    await page.getByRole("button", { name: "Preview review", exact: true }).click();
    await expect
      .element(page.getByLabelText("Review submission preview"))
      .toHaveTextContent("<!-- F5 review nonce -->");
    expect(nativeApiRef.submitReview).not.toHaveBeenCalled();
    await expect.element(page.getByRole("textbox", { name: "Review draft" })).toBeDisabled();
    await page.getByRole("button", { name: "Submit review to GitHub", exact: true }).click();
    await expect.element(page.getByText("Review submitted to GitHub.")).toBeInTheDocument();
    expect(nativeApiRef.submitReview).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("textbox", { name: "Review draft" })).toHaveValue("");
  });

  it("keeps uncertain submissions frozen and offers reconciliation without resending", async () => {
    await renderTabs();
    nativeApiRef.submitReview.mockImplementationOnce(() => {
      savedOperation = { ...savedOperation!, status: "outcome_unknown" };
      return Promise.resolve(savedOperation);
    });
    await page.getByRole("tab", { name: "Files (1)" }).click();
    await userEvent.type(page.getByRole("textbox", { name: "Review draft" }), "Check this.");
    await expect.element(page.getByText("Draft saved in F5")).toBeInTheDocument();
    await page.getByRole("button", { name: "Preview review", exact: true }).click();
    await page.getByRole("button", { name: "Submit review to GitHub", exact: true }).click();
    await page.getByRole("button", { name: "Check GitHub result", exact: true }).click();
    await expect.element(page.getByRole("textbox", { name: "Review draft" })).toBeDisabled();
    expect(nativeApiRef.submitReview).toHaveBeenCalledTimes(1);
    await expect
      .element(page.getByRole("button", { name: "Submit review to GitHub", exact: true }))
      .not.toBeInTheDocument();
  });

  it("reads review threads and publishes a reply only after an explicit click", async () => {
    await renderTabs();
    const thread = {
      id: "thread-1",
      path: "src/detail.ts",
      line: 2,
      originalLine: 2,
      isResolved: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: true,
      comments: [
        {
          id: "comment-1",
          author: "alice",
          authorId: "2",
          bodyText: "Explain this",
          body: "Explain this",
          url: "https://github.com/octo/repo/pull/1#discussion_r1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: null,
          outdated: false,
          diffHunk: null,
        },
      ],
      commentsPageInfo: { hasNextPage: false, endCursor: null, truncated: false },
    };
    const api = nativeApiRef.current!.prHub;
    api.getReviewThreads = vi.fn().mockImplementation(() =>
      Promise.resolve({
        threads: [thread],
        pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
        comparisonVersion: "comparison",
        refreshedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    api.getReplyOperation = vi.fn().mockResolvedValue(null);
    let replyDraft: PrHubReplyDraft | null = null;
    api.getReplyDraft = vi.fn().mockImplementation(async () => replyDraft);
    api.saveReplyDraft = vi.fn().mockImplementation(async (input) => {
      replyDraft = {
        version: input.expectedVersion + 1,
        body: input.body,
        comparisonVersion: input.comparisonVersion,
        updatedAt: new Date().toISOString(),
      };
      return { status: "saved", draft: replyDraft };
    });
    api.replyReviewThread = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        ...input,
        status: "succeeded",
        remoteId: "reply-1",
      }),
    );
    api.setReviewThreadState = vi.fn().mockImplementation((input) => {
      thread.isResolved = input.resolved;
      return Promise.resolve(thread);
    });
    await page.getByRole("tab", { name: "Review threads", exact: true }).click();
    await expect.element(page.getByText("Explain this", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await userEvent.type(
      page.getByRole("textbox", { name: "Reply to review thread" }),
      "Here is the explanation.",
    );
    await expect.element(page.getByLabelText("Reply preview")).toHaveTextContent("<!-- F5 reply");
    expect(api.replyReviewThread).not.toHaveBeenCalled();
    await expect.element(page.getByText("Reply draft saved", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Reply to review thread" }))
      .toHaveValue("Here is the explanation.");

    await page.getByRole("button", { name: "Post reply to GitHub" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Reply to review thread" }))
      .toHaveValue("");
    expect(api.replyReviewThread).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: "Resolve conversation" }).click();
    await expect
      .element(page.getByRole("button", { name: "Reopen conversation" }))
      .toBeInTheDocument();
    expect(api.setReviewThreadState).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", resolved: true }),
    );
  });

  it("retains an edited comment draft when the remote mutation fails", async () => {
    await renderTabs();
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect.element(page.getByText("Original comment")).toBeInTheDocument();
    nativeApiRef.updateComment.mockRejectedValueOnce(new Error("GitHub rejected the edit"));

    await page.getByRole("button", { name: "Edit comment" }).click();
    const editor = page.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Keep this draft");
    await page.getByRole("button", { name: "Save" }).click();

    await expect.element(editor).toHaveValue("Keep this draft");
    expect(nativeApiRef.updateComment).toHaveBeenCalledWith({
      key: KEY,
      commentId: "11",
      kind: "issue-comment",
      body: "Keep this draft",
    });
  });
});
