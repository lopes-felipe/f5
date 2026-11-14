import "../../index.css";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  ThreadId,
  type NativeApi,
  type PrHubListInput,
  type PrHubOverview,
  type PrHubSection,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { setPrHubAccount } from "../../lib/prHubAccount";
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
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));
// The page content has its own tests; here it only has to show what the queue hands it.
vi.mock("./PrDetailPanel", () => ({
  PrDetailPanel: ({
    pr,
    tab,
    onTabChange,
  }: {
    pr: TrackedPullRequest;
    tab: string;
    onTabChange: (tab: string) => void;
  }) => (
    <div data-testid="pr-page">
      <h2>{pr.title}</h2>
      <span data-testid="pr-page-tab">{tab}</span>
      <button type="button" onClick={() => onTabChange("timeline")}>
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
  /** The account has never finished a sync. */
  firstSync: false,
};

const isActive = (pr: TrackedPullRequest) =>
  pr.state === "open" && pr.ignoredAt === null && pr.snoozedUntil === null;

function overview(): PrHubOverview {
  const active = server.prs.filter(isActive);
  const count = (section: PrHubSection) => active.filter((pr) => pr.section === section).length;
  return {
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
      state: server.firstSync ? "syncing" : "idle",
      lastSyncedAt: server.firstSync ? null : new Date(Date.now() - 120_000).toISOString(),
      nextSyncAt: null,
      resumeAt: null,
      pending: { searches: 0, hydrations: 0 },
      message: null,
    },
    facets: { repositories: ["octo/repo"], authors: ["me", "alice"], labels: [] },
    coverage: [],
  } as unknown as PrHubOverview;
}

async function list(input: PrHubListInput & { cursor?: string }) {
  if (input.query && server.gate) await server.gate;
  if (input.section && input.section === server.failSection) throw new Error("boom");
  const rows = server.prs.filter((pr) => {
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "gen-1" });
  Object.assign(server, {
    prs: QUEUE,
    status: "ok",
    gate: null,
    failSection: null,
    firstSync: false,
  });
  api.getOverview.mockImplementation(async () => overview());
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

  server.firstSync = false;
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
});
