import "../../index.css";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  ThreadId,
  type NativeApi,
  type PrHubListInput,
  type PrHubOverview,
  type PrHubOverviewInput,
  type PrHubSection,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { APP_SETTINGS_STORAGE_KEY } from "../../appSettings";
import {
  getPrHubSelectedAccountId,
  setPrHubAccount,
  setPrHubSelectedAccountId,
} from "../../lib/prHubAccount";
import { PR_QUEUE_COLLAPSE_STORAGE_KEY } from "./prQueueModel";
import type { PrQueueSearch } from "./prQueueSearch";
import { PrQueueView } from "./PrQueueView";

const api = vi.hoisted(() => ({
  getOverview: vi.fn(),
  listPullRequests: vi.fn(),
  getDetail: vi.fn(),
  getAdvisories: vi.fn(),
  listAccounts: vi.fn(),
  markSeen: vi.fn(),
  refresh: vi.fn(),
  track: vi.fn(),
  getOperation: vi.fn(),
  bulkUpdate: vi.fn(),
  getFiles: vi.fn(),
  merge: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));
// The page content has its own tests; here it only has to show what the queue hands it.
vi.mock("./PrPageContent", () => ({
  PrPageContent: ({
    pr,
    tab,
    onTabChange,
    defaultEditingReviewers,
  }: {
    pr: TrackedPullRequest;
    tab: string;
    onTabChange: (tab: string) => void;
    defaultEditingReviewers?: boolean;
  }) => (
    <div data-testid="pr-page">
      <h2>{pr.title}</h2>
      <span data-testid="pr-page-tab">{tab}</span>
      <span data-testid="pr-page-reviewers">{defaultEditingReviewers ? "editing" : "closed"}</span>
      <button type="button" onClick={() => onTabChange("conversation")}>
        Show conversation
      </button>
    </div>
  ),
}));

const keyOf = (number: number) =>
  PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${number}`);

function makePr(
  number: number,
  title: string,
  section: PrHubSection,
  overrides: Partial<TrackedPullRequest> = {},
): TrackedPullRequest {
  const mine = section !== "review" && section !== "team";
  return {
    key: keyOf(number),
    provider: "github",
    nodeId: `PR_${number}`,
    number,
    title,
    url: `https://github.com/octo/repo/pull/${number}`,
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: mine ? "me" : "alice",
    isDraft: section === "drafts",
    state: "open",
    roles: mine ? ["author"] : [],
    attentionState:
      section === "review"
        ? "review_requested"
        : section === "team"
          ? "team_review_requested"
          : section === "ready"
            ? "ready_to_merge"
            : section === "drafts"
              ? "draft"
              : section === "action"
                ? "ci_failing"
                : "awaiting_review",
    attentionBucket: section === "waiting" ? "waiting_on_others" : "needs_you",
    primaryReason: "",
    nextAction: "Next step",
    checkRollup: section === "action" ? "failure" : "success",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: section === "review" || section === "team",
    reviewRequestSource: section === "review" ? "direct" : section === "team" ? "team" : null,
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    headRefOid: "head",
    baseRefName: "main",
    headRefName: `feature-${number}`,
    labels: [],
    assignees: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: new Date(Date.now() - number * 3_600_000).toISOString(),
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: `fp-${number}`,
    section,
    ...overrides,
  };
}

const QUEUE = [
  makePr(1, "Alpha review", "review"),
  makePr(2, "Bravo review", "review"),
  makePr(3, "Charlie fix", "action"),
  makePr(4, "Delta ready", "ready"),
  makePr(5, "Echo team", "team"),
  makePr(6, "Foxtrot team", "team"),
  makePr(7, "Golf draft", "drafts"),
];

const server = {
  prs: QUEUE as TrackedPullRequest[],
  status: "ok" as PrHubOverview["status"],
  /** Holds search requests open until released, to observe the in-between state. */
  gate: null as Promise<void> | null,
  failSection: null as PrHubSection | null,
  /** Search requests fail. */
  failSearch: false,
  /** The account has never finished a sync. */
  firstSync: false,
  /** A sync has finished, but searches are still queued behind the request budget. */
  backlog: false,
  /** What the second forge account tracks. */
  otherAccount: [] as TrackedPullRequest[],
};

const OTHER_ACCOUNT = "acc-2";
const tracked = () =>
  getPrHubSelectedAccountId() === OTHER_ACCOUNT ? server.otherAccount : server.prs;

const isActive = (pr: TrackedPullRequest) =>
  pr.state === "open" && pr.ignoredAt === null && pr.snoozedUntil === null;

const isUnread = (pr: TrackedPullRequest) => (pr.changesSinceSeen?.length ?? 0) > 0;

function overview(input: PrHubOverviewInput = {}): PrHubOverview {
  const active = (input.accountId === OTHER_ACCOUNT ? server.otherAccount : server.prs).filter(
    isActive,
  );
  const count = (section: PrHubSection) => active.filter((pr) => pr.section === section).length;
  return {
    unreadCount: active.filter(isUnread).length,
    ...(input.savedQueries?.length
      ? {
          savedCounts: Object.fromEntries(
            input.savedQueries.map((saved) => [
              saved.id,
              active.filter(
                (pr) =>
                  ["review", "action", "ready"].includes(pr.section ?? "") &&
                  pr.title.toLowerCase().includes((saved.query ?? "").toLowerCase()),
              ).length,
            ]),
          ),
        }
      : {}),
    status: server.status,
    host: "github.com",
    viewerLogin: "me",
    lastPolledAt: new Date().toISOString(),
    revision: "1",
    account: { host: "github.com", viewerId: 1, login: "me", generation: "gen-1" },
    counts: {},
    sectionCounts: {
      review: count("review"),
      action: count("action"),
      ready: count("ready"),
      waiting: count("waiting"),
      drafts: count("drafts"),
      team: count("team"),
      other: count("other"),
      stale: count("stale"),
    },
    sync: {
      state: server.firstSync || server.backlog ? "syncing" : "idle",
      lastSyncedAt: server.firstSync ? null : new Date(Date.now() - 120_000).toISOString(),
      nextSyncAt: null,
      resumeAt: null,
      pending: { searches: server.backlog ? 2 : 0, hydrations: 0 },
      message: null,
    },
    facets: { repositories: ["octo/repo"], authors: ["me", "alice"], labels: [] },
    coverage: [],
  } as unknown as PrHubOverview;
}

async function list(input: PrHubListInput & { cursor?: string }) {
  if (input.query && server.gate) await server.gate;
  if (input.section && input.section === server.failSection) throw new Error("boom");
  if (input.query && server.failSearch) throw new Error("boom");
  const rows = tracked().filter((pr) => {
    if (input.key) return pr.key === input.key;
    const visible =
      input.visibility === "ignored"
        ? pr.ignoredAt !== null
        : input.visibility === "snoozed"
          ? pr.snoozedUntil !== null
          : input.visibility === "resolved"
            ? pr.state !== "open"
            : isActive(pr);
    return (
      visible &&
      (!input.unread || isUnread(pr)) &&
      (!input.section || pr.section === input.section) &&
      (!input.query || pr.title.toLowerCase().includes(input.query.toLowerCase())) &&
      (!input.repository || pr.repository.nameWithOwner === input.repository)
    );
  });
  const offset = Number(input.cursor ?? 0);
  const end = offset + (input.limit ?? 50);
  return {
    accountGeneration: "gen-1",
    revision: "1",
    status: "ok" as const,
    pullRequests: rows.slice(offset, end),
    threadLinks: {
      [keyOf(3)]: [{ threadId: ThreadId.makeUnsafe("thread-1"), title: "Fix the build" }],
    },
    nextCursor: end < rows.length ? String(end) : null,
  };
}

const sectionRequests = () =>
  api.listPullRequests.mock.calls.map(([input]) => (input as PrHubListInput).section);

const history: PrQueueSearch[] = [];
const openThread = vi.fn();
const openSettings = vi.fn();
let active: Awaited<ReturnType<typeof render>> | undefined;
let queryClient: QueryClient;

function Harness({ initial }: { initial: PrQueueSearch }) {
  const [search, setSearch] = useState(initial);
  return (
    <PrQueueView
      search={search}
      onSearchChange={(next) => {
        history.push(next);
        setSearch(next);
      }}
      onOpenThread={openThread}
      onOpenSettings={openSettings}
    />
  );
}

async function renderQueue(initial: PrQueueSearch = {}, width = 1400) {
  await page.viewport(width, 900);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  active = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh" }}>
        <Harness initial={initial} />
      </div>
    </QueryClientProvider>,
  );
}

const row = (title: string) => page.getByRole("option", { name: new RegExp(title) });
const peek = (number: number) =>
  page.getByRole("complementary", { name: `Pull request octo/repo#${number}` });
const lastSearch = () => history.at(-1);

beforeEach(() => {
  vi.clearAllMocks();
  history.length = 0;
  window.localStorage.removeItem(PR_QUEUE_COLLAPSE_STORAGE_KEY);
  setPrHubSelectedAccountId(undefined);
  window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "gen-1" });
  Object.assign(server, {
    prs: QUEUE,
    status: "ok",
    gate: null,
    failSection: null,
    failSearch: false,
    firstSync: false,
    backlog: false,
    otherAccount: [],
  });
  api.getOverview.mockImplementation(async (input?: PrHubOverviewInput) => overview(input));
  api.bulkUpdate.mockImplementation(async ({ keys }: { keys: readonly string[] }) => ({
    updated: keys.length,
  }));
  api.listPullRequests.mockImplementation(list);
  api.getDetail.mockImplementation(async () => ({
    stale: false,
    detail: { body: "Explains the **change**." },
  }));
  api.getAdvisories.mockResolvedValue({ advisories: [] });
  api.listAccounts.mockResolvedValue([]);
  api.markSeen.mockResolvedValue(undefined);
  api.refresh.mockResolvedValue(undefined);
});

afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

it("groups the queue by section with counts and loads nothing for collapsed sections", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await expect.element(row("Charlie fix")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Review requested\s*2/ }))
    .toHaveAttribute("aria-expanded", "true");
  const team = page.getByRole("button", { name: /Team queue\s*2/ });
  await expect.element(team).toHaveAttribute("aria-expanded", "false");
  await expect.element(row("Echo team")).not.toBeInTheDocument();
  // Empty sections are left out, and collapsed ones were never requested.
  await expect
    .element(page.getByRole("button", { name: /Waiting on others/ }))
    .not.toBeInTheDocument();
  expect(sectionRequests()).not.toContain("team");
  expect(sectionRequests()).not.toContain("drafts");

  await team.click();
  await expect.element(row("Echo team")).toBeVisible();
  expect(sectionRequests()).toContain("team");
  expect(window.localStorage.getItem(PR_QUEUE_COLLAPSE_STORAGE_KEY)).toBe('{"team":false}');
});

it("shows each row's next step and its linked thread", async () => {
  await renderQueue();
  await expect.element(page.getByRole("button", { name: "Review: octo/repo#1" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Fix CI: octo/repo#3" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Merge: octo/repo#4" })).toBeVisible();

  await page.getByRole("button", { name: /Open thread Fix the build/ }).click();
  expect(openThread).toHaveBeenCalledWith("thread-1");

  // Reviewing opens the pull request's files.
  await page.getByRole("button", { name: "Review: octo/repo#1" }).click();
  await expect.poll(lastSearch).toEqual({ pr: keyOf(1), view: "page", tab: "files" });
  await expect.element(page.getByTestId("pr-page-tab")).toHaveTextContent("files");
});

it("keeps the list and the peek mounted while a search is in flight", async () => {
  await renderQueue();
  await row("Alpha review").click();
  await expect.element(peek(1)).toBeVisible();
  await expect.element(peek(1)).toHaveTextContent("Explains the change.");
  const listbox = document.querySelector('[role="listbox"][aria-label="Pull requests"]');
  const aside = document.querySelector("aside");

  let release = () => {};
  server.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("combobox", { name: "Search pull requests" }).fill("bravo");
  await expect
    .poll(() => api.listPullRequests.mock.calls.some(([input]) => input.query === "bravo"))
    .toBe(true);
  // The previous rows and the peek stay while the request is open.
  await expect.element(row("Alpha review")).toBeVisible();
  await expect.element(row("Charlie fix")).toBeVisible();
  expect(listbox?.isConnected).toBe(true);
  expect(aside?.isConnected).toBe(true);

  release();
  await expect.element(row("Charlie fix")).not.toBeInTheDocument();
  await expect.element(row("Bravo review")).toBeVisible();
  expect(document.querySelector('[role="listbox"][aria-label="Pull requests"]')).toBe(listbox);
  expect(document.querySelector("aside")).toBe(aside);
  expect(lastSearch()).toEqual({ pr: keyOf(1), q: "bravo" });
});

it("moves, peeks, opens the page and returns with the keyboard", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await userEvent.keyboard("j");
  await expect.element(row("Alpha review")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("j");
  await expect.element(row("Bravo review")).toHaveAttribute("aria-selected", "true");
  expect(history).toEqual([]);

  await userEvent.keyboard(" ");
  await expect.element(peek(2)).toBeVisible();
  await userEvent.keyboard("k");
  await expect.element(peek(1)).toBeVisible();
  await userEvent.keyboard(" ");
  await expect.element(peek(1)).not.toBeInTheDocument();
  await expect.element(row("Alpha review")).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("pr-page")).toHaveTextContent("Alpha review");
  await expect.element(page.getByText("1 of 4")).toBeVisible();
  await userEvent.keyboard("]");
  await expect.element(page.getByTestId("pr-page")).toHaveTextContent("Bravo review");
  await userEvent.keyboard("{Escape}");
  await expect.element(peek(2)).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(peek(2)).not.toBeInTheDocument();

  await userEvent.keyboard("/");
  await expect.element(page.getByRole("combobox", { name: "Search pull requests" })).toHaveFocus();
  // Keys typed into the search box are text, not commands.
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("pr-page")).not.toBeInTheDocument();
});

it("opens the page where a step of the peek's checklist is taken", async () => {
  await renderQueue();
  await row("Charlie fix").click();
  await peek(3).getByRole("button", { name: "View checks" }).click();
  await expect.poll(lastSearch).toEqual({ pr: keyOf(3), view: "page", tab: "checks" });
  await expect.element(page.getByTestId("pr-page-tab")).toHaveTextContent("checks");
  await expect.element(page.getByTestId("pr-page-reviewers")).toHaveTextContent("closed");

  await userEvent.keyboard("{Escape}");
  await peek(3).getByRole("button", { name: "Request reviewers" }).click();
  // Overview is the page's first tab, so the address does not name it.
  await expect.poll(lastSearch).toEqual({ pr: keyOf(3), view: "page" });
  await expect.element(page.getByTestId("pr-page-reviewers")).toHaveTextContent("editing");

  // Coming back another way opens the page as usual.
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("pr-page-reviewers")).toHaveTextContent("closed");
});

it("confirms a re-run of the failed jobs from the peek, without leaving the queue", async () => {
  api.getOperation.mockResolvedValue(null);
  await renderQueue();
  await row("Charlie fix").click();
  await expect.element(peek(3).getByRole("button", { name: "Fix CI with F5" })).toBeVisible();
  await peek(3).getByRole("button", { name: "Re-run failed jobs" }).click();
  await expect.element(page.getByRole("dialog", { name: "Re-run failed jobs" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Prepare re-run failed jobs", exact: true }))
    .toBeVisible();
  expect(lastSearch()).toEqual({ pr: keyOf(3) });
});

it("restores the page, its tab and the filters from the URL state", async () => {
  await renderQueue({ pr: keyOf(3), view: "page", tab: "files" });
  await expect.element(page.getByTestId("pr-page")).toHaveTextContent("Charlie fix");
  await expect.element(page.getByTestId("pr-page-tab")).toHaveTextContent("files");
  await page.getByRole("button", { name: "Show conversation" }).click();
  await expect.poll(lastSearch).toEqual({ pr: keyOf(3), view: "page", tab: "conversation" });
  await active?.unmount();

  await renderQueue({ q: "review", repo: "octo/repo", status: "snoozed" });
  await expect
    .element(page.getByRole("combobox", { name: "Search pull requests" }))
    .toHaveValue("review");
  await expect.element(page.getByText("Nothing snoozed")).not.toBeInTheDocument();
  await expect.element(page.getByText("No pull requests match")).toBeVisible();
  await page.getByRole("button", { name: "Remove repository filter" }).click();
  await expect.poll(lastSearch).toEqual({ q: "review", status: "snoozed" });
});

it("filters from the popover and shows each filter as a removable chip", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await page.getByRole("button", { name: "Filter pull requests" }).click();
  await page.getByRole("combobox", { name: "Repository", exact: true }).click();
  await page.getByRole("option", { name: "octo/repo", exact: true }).click();
  await expect.poll(lastSearch).toEqual({ repo: "octo/repo" });
  await page.getByRole("combobox", { name: "Checks", exact: true }).click();
  await page.getByRole("option", { name: "Failing", exact: true }).click();
  await expect.poll(lastSearch).toEqual({ repo: "octo/repo", ci: "failure" });
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Remove repository filter" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Remove checks filter" }).click();
  await expect.poll(lastSearch).toEqual({ repo: "octo/repo" });
});

it("completes qualifiers and opens a pasted pull request link", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  const search = page.getByRole("combobox", { name: "Search pull requests" });
  await search.fill("aut");
  await expect.element(page.getByRole("option", { name: /author:/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(search).toHaveValue("author:");
  await page.getByRole("option", { name: "author:alice", exact: true }).click();
  await expect.element(search).toHaveValue("author:alice ");
  await expect.poll(lastSearch).toEqual({ q: "author:alice " });

  api.track.mockResolvedValue(QUEUE[2]);
  await search.fill("https://github.com/octo/repo/pull/3");
  await expect.element(page.getByRole("option", { name: /Open octo\/repo#3/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("pr-page")).toHaveTextContent("Charlie fix");
  expect(api.track).toHaveBeenCalledWith({
    url: "https://github.com/octo/repo/pull/3",
    accountGeneration: "gen-1",
  });
  // The link was opened, never searched for.
  expect(api.listPullRequests.mock.calls.some(([input]) => input.query?.includes("https"))).toBe(
    false,
  );
});

it("keeps sync details behind the pill", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await expect.element(page.getByText("Everything is up to date.")).not.toBeInTheDocument();
  await page.getByRole("button", { name: /Sync status/ }).click();
  await expect.element(page.getByText("Everything is up to date.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh now" }).click();
  expect(api.refresh).toHaveBeenCalledWith({ mode: "force" });
});

it("opens the page instead of the peek when the window is narrow", async () => {
  await renderQueue({}, 900);
  await row("Alpha review").click();
  await expect.element(page.getByTestId("pr-page")).toHaveTextContent("Alpha review");
  expect(lastSearch()).toEqual({ pr: keyOf(1), view: "page" });
  await page.getByRole("button", { name: /Queue/ }).click();
  await expect.element(row("Alpha review")).toBeVisible();
  expect(lastSearch()).toEqual({});
});

it("reports a failed section in place and retries it", async () => {
  server.failSection = "action";
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not load these pull requests.");
  server.failSection = null;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(row("Charlie fix")).toBeVisible();
});

it("says so when nothing needs attention or no account is connected", async () => {
  server.prs = [];
  await renderQueue();
  await expect.element(page.getByText("All caught up")).toBeVisible();
  await active?.unmount();

  // An empty queue before the first sync finishes is not "caught up".
  server.firstSync = true;
  await renderQueue();
  await expect
    .element(page.getByRole("status", { name: "Reading your pull requests for the first time" }))
    .toBeVisible();
  await expect.element(page.getByText("All caught up")).not.toBeInTheDocument();
  await active?.unmount();

  // Nor is one whose searches are still waiting for the request budget.
  server.firstSync = false;
  server.backlog = true;
  await renderQueue();
  await expect
    .element(page.getByRole("status", { name: "Still reading your pull requests" }))
    .toBeVisible();
  await expect.element(page.getByText("All caught up")).not.toBeInTheDocument();
  await active?.unmount();

  server.backlog = false;
  server.status = "auth_required";
  await renderQueue();
  await expect.element(page.getByText("Connect GitHub")).toBeVisible();
  await page.getByRole("button", { name: "Open account settings" }).click();
  expect(openSettings).toHaveBeenCalledWith("github");
});

it("switches between status lists without section headers", async () => {
  server.prs = [
    ...QUEUE,
    makePr(8, "Hotel ignored", "review", { ignoredAt: "2026-11-10T00:00:00.000Z" }),
  ];
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await page.getByRole("button", { name: "Ignored" }).click();
  await expect.element(row("Hotel ignored")).toBeVisible();
  await expect.element(row("Alpha review")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Review requested/ }))
    .not.toBeInTheDocument();
  expect(lastSearch()).toEqual({ status: "ignored" });
  // Rows are ticked for bulk actions in the active queue only.
  await expect
    .element(page.getByRole("checkbox", { name: "Select octo/repo#8" }))
    .not.toBeInTheDocument();
});

const bulkBar = () => page.getByRole("toolbar", { name: "Selected pull requests" });
const tick = (number: number) => page.getByRole("checkbox", { name: `Select octo/repo#${number}` });

it("ticks rows with the mouse and the keyboard and updates them in one request", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  await expect.element(bulkBar()).not.toBeInTheDocument();

  await tick(1).click();
  await expect.element(bulkBar()).toHaveTextContent("1 selected");
  // Shift-click extends from the last row ticked, across sections.
  await row("Charlie fix").click({ modifiers: ["Shift"] });
  await expect.element(bulkBar()).toHaveTextContent("3 selected");
  await expect.element(tick(2)).toBeChecked();
  // Extending the selection is not opening the row.
  expect(lastSearch()).toBeUndefined();

  // X ticks or unticks the row under the cursor.
  await userEvent.keyboard("j");
  await expect.element(row("Alpha review")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("x");
  await expect.element(bulkBar()).toHaveTextContent("2 selected");
  await expect.element(tick(1)).not.toBeChecked();

  await bulkBar().getByRole("button", { name: "Mark seen" }).click();
  await expect.poll(() => api.bulkUpdate.mock.calls.length).toBe(1);
  // Each row goes with the attention it showed, so one that changed meanwhile stays unread.
  expect(api.bulkUpdate.mock.calls[0]?.[0]).toMatchObject({
    keys: [keyOf(2), keyOf(3)],
    action: "mark_seen",
    seenFingerprints: { [keyOf(2)]: "fp-2", [keyOf(3)]: "fp-3" },
  });
  await expect.element(bulkBar()).not.toBeInTheDocument();
  await expect.element(tick(2)).not.toBeChecked();
});

it("ticks a whole section, snoozes the selection and clears it with Escape", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  const section = page.getByRole("checkbox", { name: "Select all in Review requested" });
  await section.click();
  await expect.element(bulkBar()).toHaveTextContent("2 selected");
  await expect.element(tick(1)).toBeChecked();
  await expect.element(tick(2)).toBeChecked();
  await expect.element(tick(3)).not.toBeChecked();

  // Escape clears the selection before it closes anything else.
  await row("Charlie fix").click();
  await expect.element(peek(3)).toBeVisible();
  await page.getByRole("listbox", { name: "Pull requests" }).click({ position: { x: 5, y: 5 } });
  await userEvent.keyboard("{Escape}");
  await expect.element(bulkBar()).not.toBeInTheDocument();
  await expect.element(peek(3)).toBeVisible();

  await section.click();
  await bulkBar().getByRole("button", { name: "Snooze" }).click();
  await expect.element(page.getByText("Snooze 2 pull requests")).toBeVisible();
  await page.getByRole("button", { name: "Snooze", exact: true }).last().click();
  await expect.poll(() => api.bulkUpdate.mock.calls.length).toBe(1);
  const input = api.bulkUpdate.mock.calls[0]?.[0] as { until: string };
  expect(input).toMatchObject({ keys: [keyOf(1), keyOf(2)], action: "snooze" });
  expect(Date.parse(input.until)).toBeGreaterThan(Date.now());
  await expect.element(bulkBar()).not.toBeInTheDocument();
});

it("merges the ready pull requests of a selection after one confirmation", async () => {
  server.prs = QUEUE.map((pr) =>
    pr.number === 4 ? { ...pr, allowedMergeMethods: ["squash"], headRefOid: "abcdef1234567" } : pr,
  );
  api.getFiles.mockResolvedValue({
    files: [],
    comparison: {
      baseRepository: "octo/repo",
      baseRef: "main",
      baseOid: "base",
      headRepository: "octo/repo",
      headRef: "feature-4",
      headOid: "abcdef1234567",
      mergeBaseOid: "base",
      mode: "current_pr",
    },
  });
  api.merge.mockResolvedValue({});
  await renderQueue();
  await expect.element(row("Delta ready")).toBeVisible();
  await tick(3).click();
  // Nothing in the selection is ready to merge yet.
  await expect
    .element(bulkBar().getByRole("button", { name: /Merge ready/ }))
    .not.toBeInTheDocument();
  await tick(4).click();
  await bulkBar().getByRole("button", { name: "Merge ready (1)" }).click();

  const dialog = page.getByRole("dialog", { name: "Merge 1 pull request" });
  await expect.element(dialog).toBeVisible();
  const listed = dialog.getByRole("list", { name: "Pull requests to merge" });
  await expect.element(listed).toHaveTextContent("Delta ready");
  await expect.element(listed).toHaveTextContent("abcdef1");
  await expect.element(listed).toHaveTextContent("squash");
  await expect.element(listed).not.toHaveTextContent("Charlie fix");
  expect(api.merge).not.toHaveBeenCalled();

  await dialog.getByRole("button", { name: "Merge 1 pull request" }).click();
  const report = page.getByRole("dialog", { name: "Merged 1 of 1" });
  await expect.element(report).toBeVisible();
  expect(api.getFiles).toHaveBeenCalledWith({ key: keyOf(4), mode: "force" });
  expect(api.merge.mock.calls[0]?.[0]).toMatchObject({
    url: "https://github.com/octo/repo/pull/4",
    method: "squash",
    expectedComparison: { headOid: "abcdef1234567" },
  });
  await report.getByRole("button", { name: "Done" }).click();
  await expect.element(bulkBar()).not.toBeInTheDocument();
});

it("keeps the merge report when the merged pull requests leave the queue", async () => {
  const ready = (number: number, title: string) =>
    makePr(number, title, "ready", {
      allowedMergeMethods: ["squash"],
      headRefOid: `head-${number}`,
    });
  server.prs = [
    ...QUEUE.filter((pr) => pr.number !== 4),
    ready(4, "Delta ready"),
    ready(9, "India ready"),
  ];
  api.getFiles.mockImplementation(async ({ key }: { key: string }) => ({
    files: [],
    comparison: {
      baseRepository: "octo/repo",
      baseRef: "main",
      baseOid: "base",
      headRepository: "octo/repo",
      headRef: "feature",
      // The second pull request got a commit after it was listed.
      headOid: key === keyOf(9) ? "head-pushed" : "head-4",
      mergeBaseOid: "base",
      mode: "current_pr",
    },
  }));
  // As on the server: a merge refreshes the hub, and the merged row leaves the queue.
  api.merge.mockImplementation(async ({ url }: { url: string }) => {
    server.prs = server.prs.filter((pr) => pr.url !== url);
    await queryClient.invalidateQueries({ queryKey: ["prHub"] });
    return {};
  });
  await renderQueue();
  await expect.element(row("India ready")).toBeVisible();
  await tick(4).click();
  await tick(9).click();
  await bulkBar().getByRole("button", { name: "Merge ready (2)" }).click();
  await page
    .getByRole("dialog", { name: "Merge 2 pull requests" })
    .getByRole("button", { name: "Merge 2 pull requests" })
    .click();

  // The first row is gone from the queue and from the selection. The report still lists
  // both pull requests, each with what happened to it.
  const report = page.getByRole("dialog", { name: "Merged 1 of 2" });
  await expect.element(report).toBeVisible();
  await expect.element(row("Delta ready")).not.toBeInTheDocument();
  const listed = report.getByRole("list", { name: "Pull requests to merge" });
  await expect.element(listed.getByRole("listitem")).toHaveLength(2);
  await expect.element(listed).toHaveTextContent("Delta ready");
  await expect.element(listed).toHaveTextContent("Not merged. New commits were pushed");
  expect(api.merge).toHaveBeenCalledTimes(1);

  // With every selected row merged the bar is gone, and the report stays until dismissed.
  server.prs = server.prs.filter((pr) => pr.number !== 9);
  await queryClient.invalidateQueries({ queryKey: ["prHub"] });
  await expect.element(bulkBar()).not.toBeInTheDocument();
  await expect.element(report).toBeVisible();
  await report.getByRole("button", { name: "Done" }).click();
  await expect.element(report).not.toBeInTheDocument();
});

it("keeps a search as a saved view tab with its count", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  // Nothing to save and no views yet: the row of tabs stays out of the way.
  await expect.element(page.getByRole("tablist", { name: "Saved views" })).not.toBeInTheDocument();
  await active?.unmount();

  await renderQueue({ q: "review" });
  await expect.element(row("Alpha review")).toBeVisible();
  await page.getByRole("button", { name: "Save view" }).click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await dialog.getByRole("textbox", { name: "View name" }).fill("  Reviews ");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  const tab = page.getByRole("tab", { name: /Reviews/ });
  await expect.element(tab).toHaveAttribute("aria-selected", "true");
  const saved = lastSearch()?.saved;
  expect(lastSearch()).toEqual({ q: "review", saved });
  // The overview counts the view's pull requests that need you.
  await expect.element(tab).toHaveTextContent("2");
  expect(
    api.getOverview.mock.calls.some(
      ([input]) =>
        JSON.stringify((input as PrHubOverviewInput).savedQueries) ===
        JSON.stringify([{ id: saved, query: "review" }]),
    ),
  ).toBe(true);

  // Queue clears the filters and leaves the tab; the tab brings them back.
  await page.getByRole("tab", { name: "Queue" }).click();
  await expect.poll(lastSearch).toEqual({});
  await expect.element(row("Charlie fix")).toBeVisible();
  await tab.click();
  await expect.poll(lastSearch).toEqual({ q: "review", saved });
  await expect.element(row("Charlie fix")).not.toBeInTheDocument();

  // An edited search is no longer the saved view.
  await page.getByRole("combobox", { name: "Search pull requests" }).fill("alpha");
  await expect.element(tab).toHaveAttribute("aria-selected", "false");
  await expect.element(page.getByRole("button", { name: "Save view" })).toBeEnabled();
  await tab.click();

  await page.getByRole("button", { name: "Options for the view Reviews" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const rename = page.getByRole("dialog", { name: "Rename view" });
  await rename.getByRole("textbox", { name: "View name" }).fill("My reviews");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect.element(page.getByRole("tab", { name: /My reviews/ })).toBeVisible();

  await page.getByRole("button", { name: "Options for the view My reviews" }).click();
  await page.getByRole("menuitem", { name: "Delete view" }).click();
  await expect.element(page.getByRole("tab", { name: /My reviews/ })).not.toBeInTheDocument();
});

it("marks unread rows and lists them under Activity", async () => {
  server.prs = QUEUE.map((pr) =>
    pr.number === 1
      ? { ...pr, changesSinceSeen: [{ kind: "comments", count: 2 }, { kind: "commits" }] }
      : pr.number === 3
        ? { ...pr, changesSinceSeen: [{ kind: "ci_failed" }] }
        : { ...pr, changesSinceSeen: [] },
  );
  await renderQueue();
  await expect.element(row("Alpha review")).toHaveTextContent("2 new comments · New commits");
  await expect.element(row("Alpha review")).toHaveAttribute("data-unread", "true");
  await expect.element(row("Bravo review")).not.toHaveAttribute("data-unread");

  const activity = page.getByRole("button", { name: "Activity: 2 unread" });
  await expect.element(activity).toBeVisible();
  // The list is read when it is opened, not with the queue.
  expect(api.listPullRequests.mock.calls.some(([input]) => (input as PrHubListInput).unread)).toBe(
    false,
  );
  await activity.click();
  const unread = page.getByRole("list", { name: "Unread pull requests" });
  await expect.element(unread).toHaveTextContent("Checks failed");
  await expect.element(unread.getByRole("listitem")).toHaveLength(2);

  await page.getByRole("button", { name: "Mark these seen" }).click();
  await expect.poll(() => api.bulkUpdate.mock.calls.length).toBe(1);
  expect(api.bulkUpdate.mock.calls[0]?.[0]).toMatchObject({
    keys: [keyOf(1), keyOf(3)],
    action: "mark_seen",
    seenFingerprints: { [keyOf(1)]: "fp-1", [keyOf(3)]: "fp-3" },
  });

  await unread.getByRole("button", { name: /Charlie fix/ }).click();
  await expect.poll(lastSearch).toEqual({ pr: keyOf(3) });
  await expect.element(peek(3)).toBeVisible();
});

it("shows the error and Retry when a search fails, not rows that do not match it", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  server.failSearch = true;
  await page.getByRole("combobox", { name: "Search pull requests" }).fill("bravo");
  await expect.element(page.getByText("Could not load pull requests")).toBeVisible();
  await expect.element(row("Alpha review")).not.toBeInTheDocument();
  await expect.element(row("Charlie fix")).not.toBeInTheDocument();

  server.failSearch = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(row("Bravo review")).toBeVisible();
  await expect.element(row("Alpha review")).not.toBeInTheDocument();
});

it("opens the current copy of a pull request that changed while a filter is on", async () => {
  await renderQueue();
  // The section requests now hold their own copy of every row.
  await expect.element(row("Alpha review")).toBeVisible();
  await page.getByRole("combobox", { name: "Search pull requests" }).fill("alpha");
  await expect.element(row("Bravo review")).not.toBeInTheDocument();

  server.prs = QUEUE.map((pr) =>
    pr.number === 1 ? { ...pr, title: "Alpha rework", headRefOid: "head-2" } : pr,
  );
  await queryClient.invalidateQueries({ queryKey: ["prHub"] });
  await row("Alpha rework").click();
  await expect.element(peek(1)).toBeVisible();
  await expect.element(peek(1)).toHaveTextContent("Alpha rework");
});

it("leaves single keys alone while focus is outside the queue", async () => {
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();
  const elsewhere = document.createElement("button");
  elsewhere.textContent = "Elsewhere";
  document.body.append(elsewhere);
  try {
    elsewhere.focus();
    await userEvent.keyboard("j");
    await userEvent.keyboard("e");
    await expect.element(row("Alpha review")).toHaveAttribute("aria-selected", "false");
  } finally {
    elsewhere.remove();
  }

  // With focus back on the page the same key moves the cursor, and the list names that
  // row as its active descendant.
  await userEvent.keyboard("j");
  await expect.element(row("Alpha review")).toHaveAttribute("aria-selected", "true");
  const listbox = page.getByRole("listbox", { name: "Pull requests" });
  await expect
    .element(listbox)
    .toHaveAttribute("aria-activedescendant", row("Alpha review").element().id);
  expect(row("Alpha review").element().id).not.toBe("");
});

it("reads the other account as soon as it is chosen", async () => {
  api.listAccounts.mockResolvedValue([
    { id: OTHER_ACCOUNT, provider: "github", host: "ghe.example", login: "work" },
  ]);
  server.otherAccount = [makePr(21, "Zulu work review", "review")];
  await renderQueue();
  await expect.element(row("Alpha review")).toBeVisible();

  const before = api.getOverview.mock.calls.length;
  await page.getByRole("combobox", { name: "Forge account" }).click();
  await page.getByRole("option", { name: /work/ }).click();
  await expect.element(row("Zulu work review")).toBeVisible();
  await expect.element(row("Alpha review")).not.toBeInTheDocument();
  // No read after the switch went out for the account that was left.
  const after = api.getOverview.mock.calls.slice(before);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every(([input]) => input?.accountId === OTHER_ACCOUNT)).toBe(true);

  // Back on the first account its own queue returns, not the other one's cached under it.
  await page.getByRole("combobox", { name: "Forge account" }).click();
  await page.getByRole("option", { name: "Profile GitHub account" }).click();
  await expect.element(row("Alpha review")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Review requested\s*2/ })).toBeVisible();
  await expect.element(row("Zulu work review")).not.toBeInTheDocument();
});
