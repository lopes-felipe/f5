import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  type ForgeCapabilities,
  type ForgeOperation,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { ForgeControls } from "./ForgeControls";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { setPrHubAccount } from "../../lib/prHubAccount";
const api = vi.hoisted(() => ({
  listReviewerCandidates: vi.fn(),
  prepareOperation: vi.fn(),
  submitOperation: vi.fn(),
  getOperation: vi.fn(),
  recoverOperation: vi.fn(),
  cancelOperation: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
const common: ForgeCapabilities = {
  diff: true,
  search: true,
  comment: true,
  actions: ["merge", "close"],
  mergeMethods: ["merge", "squash"],
  updateMethods: [],
  reactions: false,
  labels: false,
  viewedFiles: "f5",
  review: { inlineComment: true, reply: false, resolve: false, verdicts: ["comment", "approve"] },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
  stacks: false,
  stackActions: false,
};
function fixture(provider: TrackedPullRequest["provider"] = "gitlab"): TrackedPullRequest {
  const caps: ForgeCapabilities = {
    ...common,
    ...(provider === "github"
      ? { labels: true, stacks: true, stackActions: true, viewedFiles: "host" as const }
      : provider === "azure-devops"
        ? {
            comment: false,
            review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
            reviewers: { request: true, listCandidates: false },
            edit: { changeRequest: true, comment: false },
          }
        : provider === "forgejo"
          ? { labels: true }
          : {}),
  };
  return {
    key: PullRequestKey.makeUnsafe(`${provider}:git.example.com/org/repo#7`),
    provider,
    forgeCapabilities: caps,
    nodeId: null,
    number: 7,
    title: "Change",
    url: "https://git.example.com/org/repo/pull/7",
    repository: { owner: "org", repo: "repo", nameWithOwner: "org/repo" },
    host: "git.example.com",
    author: "alice",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "awaiting_review",
    attentionBucket: "waiting_on_others",
    primaryReason: "Awaiting review",
    nextAction: "Review",
    checkRollup: "none",
    reviewDecision: "none",
    mergeable: "unknown",
    mergeStateStatus: "UNKNOWN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: ["alice"],
    reviewRequestsCount: 1,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: "head",
    baseRefName: "main",
    headRefName: "topic",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "head",
  };
}
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setPrHubAccount({ host: "git.example.com", viewerId: "viewer", generation: "generation" });
  api.listReviewerCandidates.mockResolvedValue({
    candidates: [
      { id: 1, username: "alice" },
      { id: 2, username: "bob" },
    ],
    currentReviewers: [{ id: 1, username: "alice" }],
    candidatesSupported: true,
  });
  api.getOperation.mockResolvedValue(null);
  api.prepareOperation.mockImplementation(async (input) => ({ ...input, status: "prepared" }));
  api.submitOperation.mockImplementation(async (input) => ({
    ...input,
    expectedHeadOid: "head",
    payload: { kind: "action", action: "close" },
    status: "succeeded",
  }));
});

it.each(["github", "gitlab", "bitbucket", "azure-devops", "forgejo"] as const)(
  "renders only advertised %s controls",
  async (provider) => {
    if (provider === "github" || provider === "forgejo")
      api.listReviewerCandidates.mockResolvedValue({
        candidates: [{ login: "alice" }],
        currentReviewers: [{ login: "alice" }],
        candidatesSupported: true,
      });
    if (provider === "bitbucket")
      api.listReviewerCandidates.mockResolvedValue({
        candidates: [{ uuid: "uuid-a", nickname: "alice" }],
        currentReviewers: [{ uuid: "uuid-a", nickname: "alice" }],
        candidatesSupported: true,
      });
    if (provider === "azure-devops")
      api.listReviewerCandidates.mockResolvedValue({
        candidates: [],
        currentReviewers: [{ id: "azure-id", displayName: "alice" }],
        candidatesSupported: false,
      });
    const pr = fixture(provider);
    mount(<ForgeControls pr={pr} />);
    await expect
      .element(page.getByRole("combobox", { name: "Forge action", exact: true }))
      .toBeVisible();
    expect(document.querySelector('[aria-label="Forge action"]')?.textContent).not.toContain(
      "rebase stack",
    );
    if (pr.forgeCapabilities?.labels)
      await expect
        .element(page.getByRole("textbox", { name: "Forge labels", exact: true }))
        .toBeVisible();
    else
      await expect
        .element(page.getByRole("textbox", { name: "Forge labels", exact: true }))
        .not.toBeInTheDocument();
    if (provider === "azure-devops") {
      await expect
        .element(page.getByRole("textbox", { name: "Comment and review text", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("textbox", { name: "Reviewer provider ID", exact: true }))
        .toBeVisible();
    } else
      await expect
        .element(page.getByRole("textbox", { name: "Comment and review text", exact: true }))
        .toBeVisible();
    expect(api.prepareOperation).not.toHaveBeenCalled();
    expect(api.submitOperation).not.toHaveBeenCalled();
  },
);

it("preserves the existing native reviewer ID when adding a candidate and requires confirmation", async () => {
  mount(<ForgeControls pr={fixture()} />);
  await expect
    .element(page.getByRole("checkbox", { name: "Reviewer alice", exact: true }))
    .toBeChecked();
  await page.getByRole("checkbox", { name: "Reviewer bob", exact: true }).click();
  await page.getByRole("button", { name: "Prepare reviewers", exact: true }).click();
  await expect.poll(() => api.prepareOperation.mock.calls.length).toBe(1);
  expect(api.prepareOperation.mock.calls[0]?.[0].payload).toEqual({
    kind: "reviewers",
    reviewers: ["1", "2"],
  });
  expect(api.submitOperation).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Confirm reviewers", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Reviewers preview", { exact: true }))
    .toHaveTextContent('"1"');
});

it("disables reviewer changes when existing provider identities cannot be verified", async () => {
  api.listReviewerCandidates.mockResolvedValue({
    candidates: [{ id: 2, username: "bob" }],
    currentReviewers: [{ username: "alice" }],
    candidatesSupported: true,
  });
  mount(<ForgeControls pr={fixture()} />);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Existing reviewer identities could not be verified.");
  await expect
    .element(page.getByRole("button", { name: "Prepare reviewers", exact: true }))
    .not.toBeInTheDocument();
});

it("recovers a persisted ambiguous operation without preparing or submitting again", async () => {
  const pr = fixture(),
    payload = { kind: "action" as const, action: "close" as const };
  const operation: ForgeOperation = {
    key: pr.key,
    accountGeneration: "generation",
    operationId: "saved",
    expectedHeadOid: "head",
    payload,
    status: "outcome_unknown",
  };
  localStorage.setItem(
    JSON.stringify(["forgeOperation", ["git.example.com", "viewer"], pr.key, "Close"]),
    JSON.stringify("saved"),
  );
  api.getOperation.mockResolvedValue(operation);
  api.recoverOperation.mockResolvedValue({ ...operation, status: "succeeded" });
  mount(<ForgeOperationPanel pr={pr} payload={payload} label="Close" />);
  await expect
    .element(page.getByRole("button", { name: "Check saved operation", exact: true }))
    .toBeVisible();
  expect(api.prepareOperation).not.toHaveBeenCalled();
  expect(api.submitOperation).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Check saved operation", exact: true }).click();
  await expect.poll(() => api.recoverOperation.mock.calls.length).toBe(1);
  expect(api.recoverOperation.mock.calls[0]?.[0].operationId).toBe("saved");
});
