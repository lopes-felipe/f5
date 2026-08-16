import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  NativeApi,
  PrHubDetailMutationResult,
  PrHubDetailResult,
  PrHubFilesPage,
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
    files: [{ path: "src/detail.ts", additions: 2, deletions: 1, changeType: "changed" }],
    pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
    stale: false,
    refreshedAt: "2026-01-02T00:00:00.000Z",
  };
}

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
  nativeApiRef.current = undefined;
  vi.clearAllMocks();
});

async function renderTabs() {
  const detail = detailResult();
  const timeline = timelinePage();
  const mutationResult: PrHubDetailMutationResult = { detail, timeline };
  nativeApiRef.updateComment.mockResolvedValue(mutationResult);
  nativeApiRef.setReaction.mockResolvedValue(mutationResult);
  nativeApiRef.changeReviewers.mockResolvedValue(mutationResult);
  nativeApiRef.updateBranch.mockResolvedValue(mutationResult);
  nativeApiRef.current = {
    prHub: {
      getDetail: vi.fn().mockResolvedValue(detail),
      getTimeline: vi.fn().mockResolvedValue(timeline),
      getFiles: vi.fn().mockResolvedValue(filesPage()),
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
    await expect.element(page.getByText("src/detail.ts")).toBeInTheDocument();
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
