import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  type PrHubReviewThread,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PrReviewThreadsTab } from "./PrReviewThreadsTab";
const api = vi.hoisted(() => ({
  getReviewThreads: vi.fn(),
  setReviewThreadState: vi.fn(),
  getOperation: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("./PrSendToAgent", () => ({ PrSendToAgent: () => null }));
const pr = {
  key: PullRequestKey.makeUnsafe("github:github.com/org/repo#7"),
  provider: "github",
  url: "https://github.com/org/repo/pull/7",
  repositoryArchived: true,
} as TrackedPullRequest;
const comment = (id: string, author: string, authorIsBot = false) => ({
  id,
  author,
  authorIsBot,
  url: "",
  bodyText: `${id} content`,
  createdAt: null,
  updatedAt: null,
  outdated: false,
  diffHunk: null,
});
const thread = (
  id: string,
  author: string,
  extra: Partial<PrHubReviewThread> = {},
): PrHubReviewThread => ({
  id,
  isResolved: false,
  path: "a.ts",
  line: 1,
  originalLine: 1,
  comments: [comment(id, author)],
  ...extra,
});
const threads = [
  thread("human", "alice"),
  thread("bot", "ci[bot]"),
  thread("resolved", "alice", { isResolved: true }),
  thread("paged", "ci[bot]", {
    commentsPageInfo: { hasNextPage: true, endCursor: "next-comments", truncated: false },
  }),
];
const result = (rows: PrHubReviewThread[], next = false) => ({
  threads: rows,
  comparisonVersion: "head-version",
  pageInfo: { hasNextPage: next, endCursor: next ? "next-threads" : null },
});
let screen: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient;
async function mount(subject: TrackedPullRequest = pr) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  screen = await render(
    <QueryClientProvider client={client}>
      <PrReviewThreadsTab pr={subject} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("human content", { exact: true })).toBeVisible();
}
beforeEach(() => {
  localStorage.clear();
  api.setReviewThreadState.mockReset();
  api.getReviewThreads.mockReset().mockImplementation(async (input) =>
    input.threadId
      ? result([
          thread("paged", "ci[bot]", {
            comments: [comment("paged", "ci[bot]"), comment("reply", "bob")],
          }),
        ])
      : input.cursor
        ? result([thread("later", "bob")])
        : result(threads, true),
  );
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  client?.clear();
  localStorage.clear();
});
it("filters bots and resolved threads independently and persists both choices", async () => {
  await mount();
  expect(page.getByText("bot content", { exact: true }).query()).toBeNull();
  expect(page.getByText("resolved content", { exact: true }).query()).toBeNull();
  await page.getByRole("button", { name: "Filter comments", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Bot comments", exact: true }).click();
  await expect.element(page.getByText("bot content", { exact: true })).toBeVisible();
  if (!page.getByRole("menuitemcheckbox", { name: "Resolved threads", exact: true }).query())
    await page.getByRole("button", { name: "Filter comments", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Resolved threads", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("resolved content", { exact: true })).toBeVisible();
  expect(JSON.parse(localStorage.getItem("t3code:app-settings:v1")!)).toMatchObject({
    prHubShowBotComments: true,
    prHubShowResolvedComments: true,
  });
  await screen!.unmount();
  client.clear();
  screen = undefined;
  await mount();
  await expect.element(page.getByText("bot content", { exact: true })).toBeVisible();
  await expect.element(page.getByText("resolved content", { exact: true })).toBeVisible();
  expect(api.setReviewThreadState).not.toHaveBeenCalled();
});
it("keeps more pages reachable and displays human replies under a hidden bot root", async () => {
  await mount();
  await expect
    .element(page.getByText("The loaded bot comments are hidden.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Load more comments", exact: true }).click();
  await expect.element(page.getByText("reply content", { exact: true })).toBeVisible();
  expect(page.getByText("paged content", { exact: true }).query()).toBeNull();
  await page.getByRole("button", { name: "Load more threads", exact: true }).click();
  await expect.element(page.getByText("later content", { exact: true })).toBeVisible();
  expect(api.setReviewThreadState).not.toHaveBeenCalled();
});

it("does not offer a native resolve operation denied for this thread", async () => {
  api.getOperation.mockResolvedValue(null);
  api.getReviewThreads.mockResolvedValue(
    result([thread("human", "alice", { canResolve: false, viewerCanResolve: true })]),
  );
  await mount({
    ...pr,
    provider: "gitlab",
    repositoryArchived: false,
    forgeCapabilities: {
      review: { resolve: true, reply: false },
    } as TrackedPullRequest["forgeCapabilities"],
  });
  expect(
    page.getByRole("button", { name: "Prepare resolve conversation", exact: true }).query(),
  ).toBeNull();
  expect(api.getOperation).not.toHaveBeenCalled();
});
