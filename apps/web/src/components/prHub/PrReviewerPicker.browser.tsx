import "../../index.css";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  type ForgeCapabilities,
  type PrHubDetail,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { setPrHubAccount } from "../../lib/prHubAccount";
import { PrReviewersSection } from "./PrReviewerPicker";
import { usePrDetailMutations } from "./usePrDetailMutations";

const api = vi.hoisted(() => ({
  listReviewerCandidates: vi.fn(),
  changeReviewers: vi.fn(),
  prepareOperation: vi.fn(),
  submitOperation: vi.fn(),
  getOperation: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));

const capabilities: ForgeCapabilities = {
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
  checks: { logs: false, rerun: false },
};

function fixture(
  provider: TrackedPullRequest["provider"],
  overrides: Partial<TrackedPullRequest> = {},
): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe(`${provider}:git.example.com/org/repo#7`),
    provider,
    forgeCapabilities: capabilities,
    capabilities: [{ action: "change-reviewers", supported: true }],
    nodeId: null,
    number: 7,
    title: "Change",
    url: "https://git.example.com/org/repo/pull/7",
    repository: { owner: "org", repo: "repo", nameWithOwner: "org/repo" },
    host: "git.example.com",
    author: "me",
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
    ...overrides,
  };
}

const actor = (login: string) => ({ login, name: null, avatarUrl: null });

/** Only the reviewers matter here; the section reads nothing else from the detail. */
const githubDetail = {
  reviewers: [
    { ...actor("alice"), kind: "user", requested: true },
    { ...actor("core"), kind: "team", requested: true },
    { ...actor("carol"), kind: "user", requested: false },
  ],
} as unknown as PrHubDetail;

function Subject({ pr, detail }: { pr: TrackedPullRequest; detail?: PrHubDetail }) {
  const [editing, setEditing] = useState(false);
  const mutations = usePrDetailMutations(pr);
  return (
    <PrReviewersSection
      pr={pr}
      detail={detail}
      mutations={mutations}
      editing={editing}
      onEditingChange={setEditing}
    />
  );
}

let active: Awaited<ReturnType<typeof render>> | undefined;
async function mount(pr: TrackedPullRequest, detail?: PrHubDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  active = await render(
    <QueryClientProvider client={client}>
      <Subject pr={pr} {...(detail ? { detail } : {})} />
    </QueryClientProvider>,
  );
}

const selected = () =>
  [...document.querySelectorAll('[aria-label="Selected reviewers"] li')].map((item) =>
    item.textContent?.trim(),
  );

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
  api.changeReviewers.mockResolvedValue({ detail: {}, timeline: {} });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

it("reads nothing from the forge until the editor is opened", async () => {
  await mount(fixture("gitlab"));
  await expect.element(page.getByText("alice · requested")).toBeVisible();
  expect(api.listReviewerCandidates).not.toHaveBeenCalled();
  expect(page.getByRole("group", { name: "Reviewer selection" }).query()).toBeNull();
});

it("keeps the existing reviewer's id when adding a candidate, and asks for confirmation", async () => {
  await mount(fixture("gitlab"));
  await page.getByRole("button", { name: "Request reviewers", exact: true }).click();
  await expect.poll(selected).toEqual(["alice"]);

  await page.getByRole("combobox", { name: "Reviewers", exact: true }).click();
  await page.getByRole("option", { name: "bob", exact: true }).click();
  await expect.poll(selected).toEqual(["alice", "bob"]);

  // The list stays open so several reviewers can be picked; Escape closes it.
  await userEvent.keyboard("{Escape}");
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
});

it("offers no change when the existing reviewers cannot be identified", async () => {
  api.listReviewerCandidates.mockResolvedValue({
    candidates: [{ id: 2, username: "bob" }],
    currentReviewers: [{ username: "alice" }],
    candidatesSupported: true,
  });
  await mount(fixture("gitlab"));
  await page.getByRole("button", { name: "Request reviewers", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Existing reviewer identities could not be verified.");
  expect(page.getByRole("combobox", { name: "Reviewers", exact: true }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Prepare reviewers", exact: true }).query()).toBeNull();
});

it("lets a reviewer id be typed where the forge cannot list candidates", async () => {
  api.listReviewerCandidates.mockResolvedValue({
    candidates: [],
    currentReviewers: [{ id: "azure-id", displayName: "alice" }],
    candidatesSupported: false,
  });
  await mount(fixture("azure-devops"));
  await page.getByRole("button", { name: "Request reviewers", exact: true }).click();
  await expect.poll(selected).toEqual(["alice"]);

  await page.getByRole("combobox", { name: "Reviewers", exact: true }).click();
  await page.getByRole("combobox", { name: "Search reviewers" }).fill("other-id");
  await page.getByRole("option", { name: /Add .other-id./ }).click();
  await expect.poll(selected).toEqual(["alice", "other-id"]);
});

it("does not offer typed reviewers where the forge needs its own ids", async () => {
  await mount(fixture("gitlab"));
  await page.getByRole("button", { name: "Request reviewers", exact: true }).click();
  await page.getByRole("combobox", { name: "Reviewers", exact: true }).click();
  await page.getByRole("combobox", { name: "Search reviewers" }).fill("carol");
  await expect.element(page.getByText("No matching reviewers.")).toBeVisible();
  expect(page.getByRole("option", { name: /Add/ }).query()).toBeNull();
});

it("applies a GitHub change as the requests to add and to withdraw, teams included", async () => {
  api.listReviewerCandidates.mockResolvedValue({
    candidates: [{ login: "alice" }, { login: "bob" }],
    currentReviewers: [{ login: "alice" }],
    candidatesSupported: true,
  });
  await mount(fixture("github"), githubDetail);
  await expect.element(page.getByText("@core · requested")).toBeVisible();
  await expect.element(page.getByText("carol · reviewed")).toBeVisible();

  await page.getByRole("button", { name: "Request reviewers", exact: true }).click();
  // Only pending requests can be withdrawn; a finished review is not one.
  await expect.poll(selected).toEqual(["alice", "org/core"]);
  const apply = page.getByRole("button", { name: "Apply reviewer changes", exact: true });
  await expect.element(apply).toBeDisabled();

  await page.getByRole("button", { name: "Remove alice", exact: true }).click();
  await page.getByRole("combobox", { name: "Reviewers", exact: true }).click();
  await page.getByRole("option", { name: "bob", exact: true }).click();
  await page.getByRole("combobox", { name: "Search reviewers" }).fill("org/platform");
  await page.getByRole("option", { name: /Add .org\/platform./ }).click();
  await expect.poll(selected).toEqual(["org/core", "bob", "org/platform"]);

  await userEvent.keyboard("{Escape}");
  await apply.click();
  await expect.poll(() => api.changeReviewers.mock.calls.length).toBe(1);
  expect(api.changeReviewers.mock.calls[0]?.[0]).toEqual({
    key: fixture("github").key,
    add: ["bob", "org/platform"],
    remove: ["alice"],
  });
  // A finished change closes the editor.
  await expect
    .element(page.getByRole("group", { name: "Reviewer selection" }))
    .not.toBeInTheDocument();
});

it("still takes typed GitHub logins when the collaborator list cannot be read", async () => {
  api.listReviewerCandidates.mockRejectedValue(new Error("403"));
  await mount(fixture("github"), githubDetail);
  await page.getByRole("button", { name: "Request reviewers", exact: true }).click();
  await page.getByRole("combobox", { name: "Reviewers", exact: true }).click();
  await page.getByRole("combobox", { name: "Search reviewers" }).fill("dave");
  await page.getByRole("option", { name: /Add .dave./ }).click();
  await expect.poll(selected).toEqual(["alice", "org/core", "dave"]);
});

it("is read-only when the account may not change reviewers or the pull request is closed", async () => {
  await mount(
    fixture("github", {
      capabilities: [{ action: "change-reviewers", supported: false, reason: "No permission" }],
    }),
    githubDetail,
  );
  await expect.element(page.getByText("alice · requested")).toBeVisible();
  expect(page.getByRole("button", { name: "Request reviewers", exact: true }).query()).toBeNull();
  await active?.unmount();

  await mount(fixture("gitlab", { state: "closed" }));
  await expect.element(page.getByText("alice · requested")).toBeVisible();
  expect(page.getByRole("button", { name: "Request reviewers", exact: true }).query()).toBeNull();
});
