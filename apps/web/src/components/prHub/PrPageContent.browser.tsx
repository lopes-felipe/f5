import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  type NativeApi,
  type PrHubDetailResult,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { GITHUB_FORGE_CAPABILITIES } from "@t3tools/shared/forgeCapabilities";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { setPrHubAccount } from "../../lib/prHubAccount";
import { TooltipProvider } from "../ui/tooltip";
import { PrPageContent, type PrPageContentProps } from "./PrPageContent";

const api = vi.hoisted(() => ({
  markSeen: vi.fn(),
  getDetail: vi.fn(),
  getOperation: vi.fn(),
  prepareOperation: vi.fn(),
  submitOperation: vi.fn(),
  listReviewerCandidates: vi.fn(),
  getThreadsForPr: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));
// The other tabs have their own tests; here they only have to be reachable.
vi.mock("./PrFilesTab", () => ({ PrFilesTab: () => <p>Files stub</p> }));
vi.mock("./PrTimelineTab", () => ({ PrTimelineTab: () => <p>Conversation stub</p> }));
vi.mock("./PrReviewThreadsTab", () => ({ PrReviewThreadsTab: () => <p>Threads stub</p> }));
vi.mock("./PrCommentSubmit", () => ({ PrCommentSubmit: () => null }));
vi.mock("./PrReviewSubmit", () => ({ PrReviewSubmit: () => <p>Review form stub</p> }));

const KEY = PullRequestKey.makeUnsafe("github:github.com/octo/repo#1");

function makePr(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    key: KEY,
    provider: "github",
    capabilities: [
      { action: "approve", supported: true },
      { action: "comment", supported: true },
      { action: "request-changes", supported: true },
      { action: "change-reviewers", supported: true },
      { action: "react", supported: true },
    ],
    forgeCapabilities: { ...GITHUB_FORGE_CAPABILITIES, stacks: false, stackActions: false },
    allowedMergeMethods: ["merge", "squash", "rebase"],
    nodeId: "PR_1",
    number: 1,
    title: "Tidy the parser",
    url: "https://github.com/octo/repo/pull/1",
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "ci_failing",
    attentionBucket: "needs_you",
    primaryReason: "A required check failed.",
    nextAction: "Fix failing CI",
    checkRollup: "failure",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "BEHIND",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: ["alice"],
    reviewRequestsCount: 1,
    commentsCount: 1,
    unresolvedThreadCount: 2,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    headRefOid: "head",
    baseRefName: "main",
    headRefName: "tidy-parser",
    labels: ["parser"],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fingerprint",
    ...overrides,
  };
}

const theirs = {
  author: "alice",
  roles: [],
  viewerReviewRequested: true,
  attentionState: "review_requested",
  checkRollup: "success",
  mergeStateStatus: "CLEAN",
  unresolvedThreadCount: 0,
} as const satisfies Partial<TrackedPullRequest>;

function detailResult(): PrHubDetailResult {
  return {
    stale: false,
    refreshedAt: "2026-01-02T00:00:00.000Z",
    detail: {
      key: KEY,
      providerDetails: {
        provider: "github",
        nodeId: "PR_1",
        mergeStateStatus: "BEHIND",
        headRefOid: "head",
        baseRefOid: "base",
        viewerCanUpdate: true,
        viewerDidAuthor: true,
      },
      title: "Tidy the parser",
      body: "Splits the tokenizer from the parser.",
      url: "https://github.com/octo/repo/pull/1",
      state: "open",
      isDraft: false,
      mergeable: "mergeable",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      headRefName: "tidy-parser",
      baseRefName: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      author: { login: "me", name: null, avatarUrl: null },
      labels: [],
      reviewers: [{ login: "alice", name: null, avatarUrl: null, kind: "user", requested: true }],
      checks: [
        { name: "lint", status: "success", description: null, url: null },
        {
          name: "build",
          status: "failure",
          description: "exit code 1",
          url: "https://github.com/octo/repo/actions/runs/1",
          required: true,
        },
        { name: "e2e", status: "pending", description: null, url: null },
      ],
      reactions: [],
    },
  };
}

let active: Awaited<ReturnType<typeof render>> | undefined;
async function mount(props: PrPageContentProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider delay={0}>
        <div style={{ height: 720, width: 1100, display: "flex", flexDirection: "column" }}>
          <PrPageContent {...props} />
        </div>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const lastPayload = () => api.prepareOperation.mock.calls.at(-1)?.[0].payload;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "gen-1" });
  api.markSeen.mockResolvedValue(undefined);
  api.getDetail.mockResolvedValue(detailResult());
  api.getOperation.mockResolvedValue(null);
  api.getThreadsForPr.mockResolvedValue([]);
  api.listReviewerCandidates.mockResolvedValue({
    candidates: [{ login: "alice" }, { login: "bob" }],
    currentReviewers: [{ login: "alice" }],
    candidatesSupported: true,
  });
  api.prepareOperation.mockImplementation((input) =>
    Promise.resolve({ ...input, status: "prepared" }),
  );
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

it("shows the header, the checklist and the description, with sync details folded away", async () => {
  await mount({ pr: makePr() });
  await expect.element(page.getByRole("heading", { name: "Tidy the parser" })).toBeVisible();
  await expect.element(page.getByText("octo/repo#1")).toBeVisible();
  await expect.element(page.getByText("2 files")).toBeVisible();
  await expect.element(page.getByText("Splits the tokenizer from the parser.")).toBeVisible();

  const status = page.getByRole("region", { name: "Status" });
  await expect.element(status).toHaveTextContent("Some checks failed");
  await expect.element(status).toHaveTextContent("Behind main");
  await expect.element(status).toHaveTextContent("2 unresolved");

  expect(page.getByText("Merge requirements").query()).toBeNull();
  await page.getByRole("button", { name: "Sync details" }).click();
  await expect.element(page.getByText("Merge requirements")).toBeVisible();
  await expect
    .element(page.getByText("Effective branch rules have not been verified."))
    .toBeVisible();
});

it("copies the branch name from the header", async () => {
  const written: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (value) => {
    written.push(value);
  });
  await mount({ pr: makePr() });
  await page.getByRole("button", { name: "Copy branch name tidy-parser" }).click();
  await expect.poll(() => written).toEqual(["tidy-parser"]);
});

it("queues the merge for when the pull request is ready, with the chosen method", async () => {
  await mount({ pr: makePr() });
  await page.getByRole("button", { name: "Merge options" }).click();
  await page.getByRole("menuitemradio", { name: "Squash and merge" }).click();
  await page.getByRole("menuitem", { name: "Merge when ready…" }).click();

  await expect.element(page.getByRole("dialog", { name: "Merge when ready" })).toBeVisible();
  expect(api.prepareOperation).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Prepare merge when ready", exact: true }).click();
  await expect.poll(lastPayload).toEqual({
    kind: "action",
    action: "enable-auto-merge",
    method: "squash",
  });
  // Nothing reaches the forge before the explicit confirmation.
  expect(api.submitOperation).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Confirm merge when ready", exact: true }))
    .toBeVisible();
});

it("leaves out Merge when ready where the forge cannot queue the merge", async () => {
  await mount({
    pr: makePr({
      forgeCapabilities: {
        ...GITHUB_FORGE_CAPABILITIES,
        stacks: false,
        actions: GITHUB_FORGE_CAPABILITIES.actions.filter(
          (action) => action !== "enable-auto-merge",
        ),
      },
    }),
  });
  await page.getByRole("button", { name: "Merge options" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Merge now…" })).toBeVisible();
  expect(page.getByRole("menuitem", { name: "Merge when ready…" }).query()).toBeNull();
});

it("runs each checklist step where it belongs", async () => {
  const onTabChange = vi.fn();
  await mount({ pr: makePr(), onTabChange });

  await page.getByRole("button", { name: "View checks" }).click();
  expect(onTabChange).toHaveBeenLastCalledWith("checks");
  const checks = page.getByRole("tabpanel", { name: "Checks" });
  await expect.element(checks).toHaveTextContent("1 failed, 1 running, 1 passed");
  // What blocks is open; what passed is folded.
  await expect.element(checks.getByText("build", { exact: true })).toBeVisible();
  await expect.element(checks.getByText("exit code 1")).toBeVisible();
  await expect.element(checks.getByText("Required")).toBeVisible();
  expect(checks.getByText("lint", { exact: true }).query()).toBeNull();
  await checks.getByRole("button", { name: /Passed/ }).click();
  await expect.element(checks.getByText("lint", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "View threads" }).click();
  await expect.element(page.getByText("Threads stub")).toBeVisible();

  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Update branch" }).click();
  await expect.element(page.getByRole("dialog", { name: "Update branch" })).toBeVisible();
  await page.getByRole("button", { name: "Prepare branch update", exact: true }).click();
  await expect.poll(lastPayload).toEqual({
    kind: "action",
    action: "update-branch",
    method: "merge",
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  expect(api.listReviewerCandidates).not.toHaveBeenCalled();
  await page
    .getByRole("region", { name: "Status" })
    .getByRole("button", { name: "Request reviewers" })
    .click();
  await expect.element(page.getByRole("group", { name: "Reviewer selection" })).toBeVisible();
});

it("gives a reviewer Review and the verdicts, and no merge", async () => {
  const onTabChange = vi.fn();
  await mount({ pr: makePr(theirs), onTabChange });
  expect(page.getByRole("button", { name: "Merge options" }).query()).toBeNull();

  await page.getByRole("button", { name: "Review", exact: true }).click();
  expect(onTabChange).toHaveBeenLastCalledWith("files");
  await expect.element(page.getByText("Files stub")).toBeVisible();

  await page.getByRole("button", { name: "Review options" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Comment…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Request changes…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Approve…" }).click();
  await expect.element(page.getByRole("dialog", { name: "Approve pull request" })).toBeVisible();
  await expect.element(page.getByText("Review form stub")).toBeVisible();
});

it("keeps the rare steps in the overflow menu and confirms a conversion to draft", async () => {
  await mount({ pr: makePr() });
  await page.getByRole("button", { name: "More actions" }).click();
  for (const name of [
    "Open in F5",
    "Comment…",
    "Close…",
    "Copy link",
    "Copy number",
    "Copy branch name",
    "Open on GitHub",
    "Ignore",
  ]) {
    await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  // Not a draft, not waiting on reviewers, and not in a thread that could watch it.
  expect(page.getByRole("menuitem", { name: "Mark ready…" }).query()).toBeNull();
  expect(page.getByRole("menuitem", { name: "Re-request review…" }).query()).toBeNull();
  expect(page.getByRole("menuitem", { name: /thread/ }).query()).toBeNull();

  await page.getByRole("menuitem", { name: "Convert to draft…" }).click();
  await expect.element(page.getByRole("dialog", { name: "Convert to draft" })).toBeVisible();
  await page.getByRole("button", { name: "Prepare convert to draft", exact: true }).click();
  await expect.poll(lastPayload).toEqual({ kind: "action", action: "draft" });
  expect(api.submitOperation).not.toHaveBeenCalled();
});

it("picks the reviewers of a re-request from the forge's candidates", async () => {
  await mount({ pr: makePr({ attentionState: "awaiting_review", checkRollup: "success" }) });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Re-request review…" }).click();
  const dialog = page.getByRole("dialog", { name: "Re-request review" });
  await expect
    .element(dialog.getByRole("list", { name: "Selected reviewers" }))
    .toHaveTextContent("alice");
  await dialog.getByRole("combobox", { name: "Reviewers", exact: true }).click();
  await expect.element(page.getByRole("option", { name: "bob", exact: true })).toBeVisible();
});

it("follows the tab it is given and reports the tab it is asked for", async () => {
  const onTabChange = vi.fn();
  await mount({ pr: makePr(), tab: "checks", onTabChange });
  await expect
    .element(page.getByRole("tab", { name: "Checks" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("tabpanel", { name: "Checks" })).toBeVisible();
  await expect.element(page.getByRole("tab", { name: "Threads (2)" })).toBeVisible();
  await expect.element(page.getByRole("tab", { name: "Files (2)" })).toBeVisible();

  await page.getByRole("tab", { name: "Conversation" }).click();
  expect(onTabChange).toHaveBeenLastCalledWith("conversation");
});

it("opens with the reviewer editor showing when asked to", async () => {
  await mount({ pr: makePr(), defaultEditingReviewers: true });
  await expect.element(page.getByRole("group", { name: "Reviewer selection" })).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Reviewers", exact: true }))
    .toBeVisible();
});

it("confirms in place of the tabs when compact, without a dialog", async () => {
  await mount({ pr: makePr(), compact: true });
  await page.getByRole("button", { name: "Snooze", exact: true }).click();
  await expect.element(page.getByRole("region", { name: "Snooze pull request" })).toBeVisible();
  expect(page.getByRole("dialog").query()).toBeNull();
});

it("offers a merged pull request only what still applies", async () => {
  await mount({
    pr: makePr({ state: "merged", attentionState: "merged", attentionBucket: "informational" }),
  });
  await expect.element(page.getByText("Merged", { exact: true })).toBeVisible();
  expect(page.getByRole("region", { name: "Status" }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Snooze", exact: true }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Merge options" }).query()).toBeNull();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  for (const name of ["Close…", "Ignore", "Open in F5", "Convert to draft…"]) {
    expect(page.getByRole("menuitem", { name, exact: true }).query()).toBeNull();
  }
});
