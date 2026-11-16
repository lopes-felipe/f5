import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  ProjectId,
  ThreadId,
  type PullRequestWatchChanged,
  type PullRequestWatchEntry,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../../types";
import { ThreadPrLinks } from "./ThreadPrLinks";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  onChanged: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ pullRequestWatches: api }),
}));

const threadId = ThreadId.makeUnsafe("thread-watch-browser");
const linkedKey = PullRequestKey.makeUnsafe("github:github.com/org/repo#7");
const otherKey = PullRequestKey.makeUnsafe("github:github.com/org/repo#8");
const timestamp = "2026-10-19T12:00:00.000Z";
const watch = (key: PullRequestKey): PullRequestWatchEntry => ({
  threadId,
  key,
  watch: {
    startedAt: timestamp,
    headSha: "head",
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: timestamp,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
});

function thread(): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: timestamp,
    archivedAt: null,
    lastInteractionAt: timestamp,
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    lastVisitedAt: timestamp,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    pullRequests: [
      {
        provider: "github",
        host: "github.com",
        repository: "org/repo",
        number: 7,
        title: "Change",
        url: "https://github.com/org/repo/pull/7",
      },
    ],
  };
}

let changed: ((input: PullRequestWatchChanged) => void) | undefined;
let saved: PullRequestWatchEntry[];
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  useStore.setState({ threads: [thread()] });
  saved = [];
  api.list.mockReset().mockImplementation(async () => saved);
  api.start.mockReset();
  api.stop.mockReset().mockImplementation(async () => {
    saved = [];
  });
  api.onChanged.mockReset().mockImplementation((handler: typeof changed) => {
    changed = handler;
    return () => {
      changed = undefined;
    };
  });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  useStore.setState({ threads: [] });
});

async function mount() {
  active = await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThreadPrLinks threadId={threadId} />
    </QueryClientProvider>,
  );
}

it("shows only watches on PRs the thread does not link, updated by server pushes", async () => {
  await mount();
  await expect.poll(() => changed !== undefined).toBe(true);
  saved = [watch(linkedKey), watch(otherKey)];
  changed?.({ threadId });
  await expect
    .element(page.getByRole("button", { name: `Stop watching ${otherKey}`, exact: true }))
    .toBeVisible();
  expect(
    page.getByRole("button", { name: `Stop watching ${linkedKey}`, exact: true }).query(),
  ).toBeNull();

  await page.getByRole("button", { name: `Stop watching ${otherKey}`, exact: true }).click();
  await expect.poll(() => api.stop.mock.calls.length).toBe(1);
  expect(api.stop).toHaveBeenCalledWith({ threadId, pr: otherKey });
  await expect
    .element(page.getByRole("button", { name: `Stop watching ${otherKey}`, exact: true }))
    .not.toBeInTheDocument();
});

it("keeps a failed stop visible as an error", async () => {
  saved = [watch(otherKey)];
  api.stop.mockRejectedValue(new Error("private provider details"));
  await mount();
  await page.getByRole("button", { name: `Stop watching ${otherKey}`, exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not update the PR watch.");
  expect(page.getByText("private provider details").query()).toBeNull();
});
