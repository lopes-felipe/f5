import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PullRequestKey, type TrackedPullRequest, type NativeApi } from "@t3tools/contracts";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PrActionDialogs } from "./PrActionDialogs";
import { PrTimelineTab } from "./PrTimelineTab";
import type { PrActionDialogProps } from "./usePrActions";
import type { usePrDetailMutations } from "./usePrDetailMutations";

const api = vi.hoisted(() => ({
  prepareOperation: vi.fn(),
  submitOperation: vi.fn(),
  getOperation: vi.fn(),
  getTimeline: vi.fn(),
  legacy: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));
vi.mock("../../lib/prHubAccount", () => ({
  getPrHubAccountGeneration: () => "gen-1",
  getPrHubSelectedAccountId: () => undefined,
  getPrHubDraftIdentity: () => ["gitlab.example", 42],
}));
const KEY = PullRequestKey.makeUnsafe("gitlab:gitlab.example/octo/repo#1");
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
function nativePr(): TrackedPullRequest {
  return {
    ...makePr(),
    provider: "gitlab",
    host: "gitlab.example",
    key: KEY,
    url: "https://gitlab.example/octo/repo/-/merge_requests/1",
    allowedMergeMethods: ["merge", "squash"],
    forgeCapabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "update-branch"],
      mergeMethods: ["merge", "squash"],
      updateMethods: ["rebase"],
      search: true,
      reactions: true,
      labels: false,
      viewedFiles: "f5",
      review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment", "approve"] },
      reviewers: { request: true, listCandidates: true },
      edit: { changeRequest: true, comment: true },
      stacks: false,
      stackActions: false,
    },
  };
}
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.getOperation.mockResolvedValue(null);
  api.prepareOperation.mockImplementation((input) =>
    Promise.resolve({ ...input, status: "prepared" }),
  );
  api.submitOperation.mockImplementation((input) =>
    Promise.resolve({
      ...input,
      expectedHeadOid: "head",
      payload: { kind: "comment", body: "" },
      status: "succeeded",
    }),
  );
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
async function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  active = await render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
function dialogProps(pendingAction: PrActionDialogProps["pendingAction"]): PrActionDialogProps {
  return {
    pr: nativePr(),
    pendingAction,
    setPendingAction: vi.fn(),
    dialogTitle: "Native action",
    reviewers: "42",
    setReviewers: vi.fn(),
    mergeMethod: "squash",
    allowedMergeMethods: ["merge", "squash"],
    mergeComparison: null,
    mergeComparisonError: "The legacy comparison is unavailable",
    reloadMergeComparison: vi.fn(),
    setMergeMethod: vi.fn(),
    snoozeUntil: "",
    setSnoozeUntil: vi.fn(),
    isRunning: false,
    runAction: api.legacy,
    candidatePicker: null,
    setCandidatePicker: vi.fn(),
    isOpeningInF5: false,
    selectFolder: vi.fn(),
    openInF5: vi.fn(),
  };
}
it("native merge previews and confirms a saved operation without calling the legacy action", async () => {
  await mount(<PrActionDialogs {...dialogProps("merge")} />);
  await page.getByRole("button", { name: "Prepare merge", exact: true }).click();
  expect(api.prepareOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      key: KEY,
      expectedHeadOid: "head",
      payload: { kind: "action", action: "merge", method: "squash" },
    }),
  );
  expect(api.submitOperation).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Confirm merge", exact: true }).click();
  expect(api.submitOperation).toHaveBeenCalledTimes(1);
  expect(api.legacy).not.toHaveBeenCalled();
});
it("native approval preserves the requested verdict and explanation", async () => {
  await mount(<PrActionDialogs {...dialogProps("approve")} />);
  await page
    .getByRole("textbox", { name: "Review explanation" })
    .fill("Looks good after checking the edge case.");
  await page.getByRole("button", { name: "Prepare approve", exact: true }).click();
  expect(api.prepareOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: {
        kind: "review",
        verdict: "approve",
        body: "Looks good after checking the edge case.",
      },
    }),
  );
  expect(api.legacy).not.toHaveBeenCalled();
});
it("native comment edits and reactions use saved operations instead of GitHub RPCs", async () => {
  api.getTimeline.mockResolvedValue({
    entries: [
      {
        type: "comment",
        id: "4",
        databaseId: "4",
        kind: "issue-comment",
        author: { login: "me", name: null, avatarUrl: null },
        body: "Old remark",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
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
    refreshedAt: "2026-01-01T00:00:00Z",
  });
  const mutations = {
    updateComment: { isPending: false, mutateAsync: api.legacy },
    setReaction: { isPending: false, mutate: api.legacy },
  } as unknown as ReturnType<typeof usePrDetailMutations>;
  await mount(<PrTimelineTab pr={nativePr()} active mutations={mutations} />);
  await page.getByRole("button", { name: "Edit comment", exact: true }).click();
  await page.getByRole("textbox").fill("Updated native remark");
  await page.getByRole("button", { name: "Prepare edit comment 4", exact: true }).click();
  expect(api.prepareOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: { kind: "edit-comment", commentId: "4", body: "Updated native remark" },
    }),
  );
  expect(api.legacy).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Prepare reaction to comment 4", exact: true }))
    .toBeInTheDocument();
});
