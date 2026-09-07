import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  PullRequestKey,
  ProjectId,
  ThreadId,
  type TrackedPullRequest,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { useStore } from "../../store";
import { usePrActions } from "./usePrActions";
import { PrActionDialogs } from "./PrActionDialogs";
const api = vi.hoisted(() => ({
  resolve: vi.fn(),
  dispatch: vi.fn(),
  start: vi.fn(),
  pick: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    prHub: { resolveLocalCheckout: api.resolve },
    dialogs: { pickFolder: api.pick },
    server: { getConfig: async () => ({ providers: [] }) },
    orchestration: { dispatchCommand: api.dispatch },
  }),
}));
vi.mock("../../appSettings", () => ({
  useAppSettings: () => ({ settings: { addProjectBaseDirectory: "C:\\dev" } }),
}));
vi.mock("./prF5Thread", async (original) => ({
  ...(await original<typeof import("./prF5Thread")>()),
  createPrF5Thread: api.start,
}));
vi.mock("./PrCommentSubmit", () => ({ PrCommentSubmit: () => null }));
vi.mock("./PrReviewSubmit", () => ({ PrReviewSubmit: () => null }));
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

function Harness() {
  const pr = { ...makePr(), unresolvedThreadCount: 2, actionableUnresolvedThreadCount: 2 };
  const actions = usePrActions(pr);
  return (
    <>
      <button onClick={actions.handlers.onOpenInF5}>Open in F5</button>
      <button onClick={actions.handlers.onRunInF5}>Address comments</button>
      <PrActionDialogs {...actions.dialogProps} />
    </>
  );
}
const candidate = {
  cwd: "C:\\dev\\repo",
  projectId: null,
  projectTitle: "repo",
  repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
};
let active: Awaited<ReturnType<typeof render>> | undefined;
function publishProject(command: OrchestrationCommand) {
  if (command.type !== "project.create") throw new Error("Unexpected command");
  useStore.setState({
    projects: [
      {
        id: command.projectId,
        cwd: command.workspaceRoot,
        name: command.title,
        model: "gpt-5.4",
        createdAt: command.createdAt,
        expanded: true,
        scripts: [],
        memories: [],
      },
    ],
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ projects: [] });
  api.resolve.mockResolvedValue([candidate]);
  api.dispatch.mockImplementation(async (command) => publishProject(command));
  api.start.mockResolvedValue({
    threadId: ThreadId.makeUnsafe("started"),
    worktreePath: "C:\\worktree",
  });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
it.each(["Open in F5", "Address comments"])(
  "registers a discovered clone and continues %s once after the project event",
  async (action) => {
    let command: OrchestrationCommand | undefined;
    api.dispatch.mockImplementation(async (input) => {
      command = input;
    });
    active = await render(<Harness />);
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => api.dispatch.mock.calls.length).toBe(1);
    expect(api.start).not.toHaveBeenCalled();
    await page.getByRole("button", { name: action, exact: true }).click();
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    publishProject(command!);
    await expect.poll(() => api.start.mock.calls.length).toBe(1);
    expect(api.start.mock.calls[0]?.[0].intent).toBe(action === "Open in F5" ? "open" : "fix");
    expect(api.resolve.mock.calls[0]?.[0].baseDirectory).toBe("C:\\dev");
  },
);
it("allows manual selection after a miss and preserves cancellation", async () => {
  api.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([candidate]);
  active = await render(<Harness />);
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "No matching F5 project" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(api.dispatch).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Existing repository folder" })
    .fill("C:\\elsewhere\\repo");
  await page.getByRole("button", { name: "Select existing folder" }).click();
  await expect.poll(() => api.start.mock.calls.length).toBe(1);
  expect(api.resolve.mock.calls.at(-1)?.[0]).toMatchObject({ selectedPath: "C:\\elsewhere\\repo" });
});
it("asks which clone to use and surfaces inspection failures without registration", async () => {
  api.resolve.mockResolvedValueOnce([
    candidate,
    { ...candidate, cwd: "C:\\second", projectTitle: "second" },
  ]);
  active = await render(<Harness />);
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Choose local clone" })).toBeVisible();
  expect(api.dispatch).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  api.resolve.mockRejectedValueOnce(new Error("Directory is inaccessible"));
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Directory is inaccessible");
  expect(api.dispatch).not.toHaveBeenCalled();
});

it("retains registration after a failed action and reuses it on retry", async () => {
  api.start.mockRejectedValueOnce(new Error("Could not create worktree"));
  api.resolve.mockImplementation(async () => [
    { ...candidate, projectId: useStore.getState().projects[0]?.id ?? null },
  ]);
  active = await render(<Harness />);
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await expect.poll(() => api.start.mock.calls.length).toBe(1);
  expect(useStore.getState().projects).toHaveLength(1);
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await expect.poll(() => api.start.mock.calls.length).toBe(2);
  expect(api.dispatch).toHaveBeenCalledTimes(1);
});

it("reuses a local project despite Windows path casing and separators", async () => {
  useStore.setState({
    projects: [
      {
        id: ProjectId.makeUnsafe("already-added"),
        name: "Existing",
        cwd: "c:/DEV/REPO/",
        model: "gpt-5.4",
        createdAt: "2026-01-01T00:00:00Z",
        scripts: [],
        memories: [],
        expanded: true,
      },
    ],
  });
  active = await render(<Harness />);
  await page.getByRole("button", { name: "Open in F5", exact: true }).click();
  await expect.poll(() => api.start.mock.calls.length).toBe(1);
  expect(api.dispatch).not.toHaveBeenCalled();
  expect(api.start.mock.calls[0]?.[0].candidate.projectId).toBe("already-added");
});
it("does nothing when the native folder picker is canceled", async () => {
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  try {
    api.resolve.mockResolvedValue([]);
    api.pick.mockResolvedValue(null);
    active = await render(<Harness />);
    await page.getByRole("button", { name: "Open in F5", exact: true }).click();
    await page.getByRole("button", { name: "Select existing folder" }).click();
    expect(api.pick).toHaveBeenCalledTimes(1);
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.dispatch).not.toHaveBeenCalled();
  } finally {
    if (previous) Object.defineProperty(window, "desktopBridge", previous);
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});
