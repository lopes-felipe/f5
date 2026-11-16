import "../index.css";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { WorktreeRemovalDialog } from "./WorktreeRemovalDialog";
import { WorktreeMissingBanner } from "./chat/WorktreeMissingBanner";

const api = vi.hoisted(() => ({
  worktrees: { inspect: vi.fn(), remove: vi.fn(), threadState: vi.fn(), recover: vi.fn() },
  nextTurnQueue: { list: vi.fn() },
}));
vi.mock("../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));
afterEach(() => vi.resetAllMocks());
const projectId = ProjectId.makeUnsafe("project");
const inspection = (branch: string, options = {}) => ({
  exists: true,
  registration: null,
  blockedReasons: [],
  linkedThreads: [],
  deletedThreadClaims: [],
  branch,
  headSha: "abc",
  branchExists: true,
  branchMerged: true,
  branchPushed: false,
  branchUpstreamGone: false,
  branchDeletable: true,
  branchBlockedReason: null,
  ...options,
});
const mount = (children: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  );
it("defaults merged branches on, keeps pushed branches optional, and disables blocked rows", async () => {
  api.worktrees.inspect.mockImplementation(async ({ path }: { path: string }) =>
    path === "/blocked"
      ? inspection("protected", {
          blockedReasons: ["Ignored .env must be kept"],
          branchDeletable: false,
          branchBlockedReason: "A conversation references this branch",
        })
      : inspection(path.slice(1), {
          branchMerged: path === "/merged",
          branchPushed: path === "/pushed",
          linkedThreads:
            path === "/merged" ? [{ threadId: "idle", title: "Review", archived: true }] : [],
        }),
  );
  api.worktrees.remove.mockResolvedValue({
    removed: false,
    branchDeleted: false,
    blockedReasons: ["HEAD changed since inspection"],
  });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog
      rows={["/merged", "/pushed", "/blocked"].map((path) => ({ projectId, path }))}
      onClose={close}
    />,
  );
  await expect
    .element(screen.getByRole("checkbox", { name: "/merged", exact: true }))
    .toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "Also delete branch merged" }))
    .toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "Also delete branch pushed" }))
    .not.toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "/blocked", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByText(/Linked idle conversations will recreate/)).toBeVisible();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.remove.mock.calls.length).toBe(2);
  expect(api.worktrees.remove.mock.calls[0]?.[0]).toMatchObject({
    expectedHead: "abc",
    deleteBranch: true,
  });
  expect(api.worktrees.remove.mock.calls[1]?.[0]).toMatchObject({ deleteBranch: false });
  expect(close).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Keep all" }).click();
  expect(close).toHaveBeenCalledOnce();
});
it("shows all ignored paths and requires explicit confirmation before sending their approval", async () => {
  const entries = [
    "apps/desktop/.turbo/",
    "apps/desktop/dist-electron/",
    "apps/desktop/dist-native/",
    "docs/ci-issue-drafts/",
    ".env",
    "node_modules/",
  ];
  const blockedReason = "Ignored files and folders require explicit deletion confirmation.";
  api.worktrees.inspect.mockResolvedValue(
    inspection("feature", {
      branchMerged: false,
      blockedReasons: [blockedReason],
      ignoredFiles: {
        entries,
        truncated: false,
        requiresApproval: true,
        canRemoveAfterApproval: true,
      },
    }),
  );
  api.worktrees.remove.mockResolvedValue({
    removed: true,
    branchDeleted: false,
    blockedReasons: [],
  });
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/ignored" }]} onClose={vi.fn()} />,
  );
  const select = screen.getByRole("checkbox", { name: "/ignored", exact: true });
  await expect.element(select).toBeDisabled();
  for (const entry of entries)
    await expect.element(screen.getByText(entry, { exact: true })).toBeVisible();
  const approval = screen.getByRole("checkbox", {
    name: /Also delete the ignored files and folders/,
  });
  await expect.element(approval).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await approval.click();
  await expect.element(select).toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeEnabled();
  await approval.click();
  await expect.element(select).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await approval.click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.remove.mock.calls.length).toBe(1);
  expect(api.worktrees.remove.mock.calls[0]?.[0]).toMatchObject({
    approvedIgnoredEntries: entries,
    deleteBranch: false,
    expectedHead: "abc",
  });
});

it.each(["local changes", "truncated"])(
  "keeps ignored approval from bypassing %s",
  async (condition) => {
    const truncated = condition === "truncated";
    const ignoredReason = truncated
      ? "too many ignored files to check"
      : "Ignored files and folders require explicit deletion confirmation.";
    api.worktrees.inspect.mockResolvedValue(
      inspection("feature", {
        blockedReasons: truncated ? [ignoredReason] : [ignoredReason, "it has uncommitted changes"],
        ignoredFiles: {
          entries: [".env"],
          truncated,
          requiresApproval: !truncated,
          canRemoveAfterApproval: false,
        },
      }),
    );
    const screen = await mount(
      <WorktreeRemovalDialog rows={[{ projectId, path: "/blocked" }]} onClose={vi.fn()} />,
    );
    await expect.element(screen.getByText(".env", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("checkbox", { name: "/blocked", exact: true }))
      .toBeDisabled();
    if (truncated)
      await expect.element(screen.getByText(/ignored-file list is incomplete/)).toBeVisible();
    else
      await expect
        .element(
          screen.getByRole("checkbox", { name: /Also delete the ignored files and folders/ }),
        )
        .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
    expect(api.worktrees.remove).not.toHaveBeenCalled();
  },
);

it("refreshes a rejected approval and requires confirmation of the new list", async () => {
  const blockedReason = "Ignored files need review.";
  const inspected = (entries: string[], headSha: string) =>
    inspection("feature", {
      headSha,
      branchMerged: false,
      blockedReasons: [blockedReason],
      ignoredFiles: {
        entries,
        truncated: false,
        requiresApproval: true,
        canRemoveAfterApproval: true,
      },
    });
  api.worktrees.inspect
    .mockResolvedValueOnce(inspected([".env"], "old"))
    .mockResolvedValue(inspected([".env", ".env.local"], "fresh"));
  api.worktrees.remove
    .mockResolvedValueOnce({
      removed: false,
      branchDeleted: false,
      blockedReasons: ["Ignored files changed since review. Inspect this checkout again."],
    })
    .mockResolvedValue({ removed: true, branchDeleted: false, blockedReasons: [] });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/stale" }]} onClose={close} />,
  );
  const approval = screen.getByRole("checkbox", {
    name: /Also delete the ignored files and folders/,
  });
  await approval.click();
  await expect
    .element(screen.getByText("Ready to remove (ignored files will be deleted)", { exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.inspect.mock.calls.length).toBe(2);
  await expect.element(screen.getByText(".env.local", { exact: true })).toBeVisible();
  await expect.element(approval).not.toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "/stale", exact: true }))
    .not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await expect
    .element(screen.getByText("Ready to remove (ignored files will be deleted)", { exact: true }))
    .not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  await approval.click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.remove.mock.calls.length).toBe(2);
  expect(api.worktrees.remove.mock.calls[1]?.[0]).toMatchObject({
    expectedHead: "fresh",
    approvedIgnoredEntries: [".env", ".env.local"],
    deleteBranch: false,
  });
  await expect.poll(() => close.mock.calls.length).toBe(1);
});

it("offers inspection retry after rejection recovery fails without retaining old approval", async () => {
  const inspected = inspection("feature", {
    blockedReasons: ["Review ignored files."],
    ignoredFiles: {
      entries: [".env"],
      truncated: false,
      requiresApproval: true,
      canRemoveAfterApproval: true,
    },
  });
  api.worktrees.inspect
    .mockResolvedValueOnce(inspected)
    .mockRejectedValueOnce(new Error("Inspection temporarily unavailable"))
    .mockResolvedValue(inspected);
  api.worktrees.remove.mockRejectedValue(new Error("Removal rejected"));
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/retry" }]} onClose={vi.fn()} />,
  );
  await screen.getByRole("checkbox", { name: /Also delete the ignored files and folders/ }).click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Inspection temporarily unavailable");
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await expect
    .element(screen.getByRole("checkbox", { name: "/retry", exact: true }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Inspect again" }).click();
  await expect
    .element(screen.getByRole("checkbox", { name: /Also delete the ignored files and folders/ }))
    .not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
});

it("closes after every removal succeeds", async () => {
  api.worktrees.inspect.mockResolvedValue(inspection("feature"));
  api.worktrees.remove.mockResolvedValue({
    removed: true,
    branchDeleted: true,
    blockedReasons: [],
  });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/safe" }]} onClose={close} />,
  );
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeEnabled();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => close.mock.calls.length).toBe(1);
});
it("offers explicit recovery with a fresh queue revision for a missing branch", async () => {
  api.worktrees.threadState.mockResolvedValue({
    worktreePath: "/gone",
    branch: "feature",
    directoryExists: false,
    registration: "none",
    branchExists: false,
    defaultBranch: "main",
  });
  api.nextTurnQueue.list.mockResolvedValue({ revision: 42 });
  api.worktrees.recover.mockRejectedValue(new Error("The queue changed. Refresh and try again."));
  const threadId = ThreadId.makeUnsafe("thread");
  const screen = await mount(
    <WorktreeMissingBanner threadId={threadId} worktreePath="/gone" branch="feature" />,
  );
  await screen.getByRole("button", { name: "Recreate from main" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("The queue changed");
  expect(api.worktrees.recover).toHaveBeenCalledWith({
    threadId,
    expectedQueueRevision: 42,
    action: "recreateFromBase",
  });
  await expect
    .element(screen.getByRole("button", { name: "Continue in project checkout" }))
    .toBeEnabled();
});
it("offers recreate now in the queue when the original branch survives", async () => {
  api.worktrees.threadState.mockResolvedValue({
    worktreePath: "/gone",
    branch: "feature",
    directoryExists: false,
    registration: "stale",
    branchExists: true,
    defaultBranch: "main",
  });
  const screen = await mount(
    <WorktreeMissingBanner threadId={ThreadId.makeUnsafe("queued")} queueBlocked />,
  );
  await expect.element(screen.getByRole("button", { name: "Recreate now" })).toBeVisible();
});

const driftState = {
  worktreePath: "/drifted",
  branch: "t3code/abc",
  directoryExists: true,
  registration: "otherBranch",
  branchExists: true,
  defaultBranch: "main",
  checkoutBranch: "feat/x",
  branchDriftOnly: true,
  checkoutDirty: false,
} as const;

it("offers one-click branch fixes when the worktree only switched branches", async () => {
  api.worktrees.threadState.mockResolvedValue(driftState);
  api.nextTurnQueue.list.mockResolvedValue({ revision: 3 });
  api.worktrees.recover.mockResolvedValue({});
  const threadId = ThreadId.makeUnsafe("drift");
  const screen = await mount(
    <WorktreeMissingBanner threadId={threadId} worktreePath="/drifted" branch="t3code/abc" />,
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "This worktree is on feat/x, but this thread expects t3code/abc. Your files are untouched.",
    );
  await expect
    .element(screen.getByRole("button", { name: "Switch back to t3code/abc" }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Use feat/x" }).click();
  expect(api.worktrees.recover).toHaveBeenCalledWith({
    threadId,
    action: "adoptCheckoutBranch",
    expectedQueueRevision: 3,
  });
  await screen.getByRole("button", { name: "More options" }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Recreate from main" })).toBeVisible();
  await expect
    .element(screen.getByRole("menuitem", { name: "Continue in project checkout" }))
    .toBeVisible();
});

it("keeps adopting available but disables transitions while a turn is running", async () => {
  api.worktrees.threadState.mockResolvedValue({ ...driftState, checkoutDirty: true });
  const screen = await mount(
    <WorktreeMissingBanner
      threadId={ThreadId.makeUnsafe("drift-busy")}
      worktreePath="/drifted"
      branch="t3code/abc"
      turnActive
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Use feat/x" })).toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: "Switch back to t3code/abc" }))
    .toBeDisabled();
  await expect
    .element(screen.getByText("Commit or stash the worktree's changes to switch back."))
    .toBeVisible();
  await expect
    .element(screen.getByText("Available after the current turn finishes."))
    .toBeVisible();
});

it("hides adopting for a detached HEAD", async () => {
  api.worktrees.threadState.mockResolvedValue({ ...driftState, checkoutBranch: null });
  const screen = await mount(
    <WorktreeMissingBanner
      threadId={ThreadId.makeUnsafe("drift-detached")}
      worktreePath="/drifted"
      branch="t3code/abc"
    />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("is on a detached HEAD");
  expect(screen.getByRole("button", { name: /^Use / }).query()).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Switch back to t3code/abc" }))
    .toBeDisabled();
  await expect.element(screen.getByText(/commits on the detached HEAD are kept/)).toBeVisible();
});

it("says the thread follows the branch at turn end instead of promising a later switch back", async () => {
  api.worktrees.threadState.mockResolvedValue({ ...driftState, followsCheckoutAtTurnEnd: true });
  const screen = await mount(
    <WorktreeMissingBanner
      threadId={ThreadId.makeUnsafe("drift-follow")}
      worktreePath="/drifted"
      branch="t3code/abc"
      turnActive
    />,
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("When this turn ends, the thread switches to feat/x.");
  await expect.element(screen.getByRole("button", { name: "Use feat/x" })).toBeEnabled();
  expect(screen.getByRole("button", { name: /^Switch back/ }).query()).toBeNull();
});

it("enables switching back once the worktree's changes are committed elsewhere", async () => {
  api.worktrees.threadState.mockResolvedValue({ ...driftState, checkoutDirty: true });
  const screen = await mount(
    <WorktreeMissingBanner
      threadId={ThreadId.makeUnsafe("drift-refresh")}
      worktreePath="/drifted"
      branch="t3code/abc"
    />,
  );
  const switchBack = screen.getByRole("button", { name: "Switch back to t3code/abc" });
  await expect.element(switchBack).toBeDisabled();
  // e.g. the user committed in the integrated terminal; no query input changes.
  api.worktrees.threadState.mockResolvedValue(driftState);
  await expect.element(switchBack, { timeout: 8_000 }).toBeEnabled();
});

it("closes when selected removals succeed even when other rows are kept or blocked", async () => {
  api.worktrees.inspect.mockImplementation(async ({ path }: { path: string }) =>
    inspection(path, path === "/blocked" ? { blockedReasons: ["Protected files"] } : {}),
  );
  api.worktrees.remove.mockResolvedValue({
    removed: true,
    branchDeleted: false,
    blockedReasons: [],
  });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog
      rows={["/selected", "/kept", "/blocked"].map((path) => ({ projectId, path }))}
      onClose={close}
    />,
  );
  const kept = screen.getByRole("checkbox", { name: "/kept", exact: true });
  await expect.element(kept).toBeChecked();
  await kept.click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => close.mock.calls.length).toBe(1);
  expect(api.worktrees.remove).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "keeps interrupted recovery retryable after reload (queue: %s)",
  async (queueBlocked) => {
    api.worktrees.threadState.mockResolvedValue({
      worktreePath: "/recovered",
      branch: "feature",
      directoryExists: true,
      registration: "matching",
      branchExists: true,
      defaultBranch: "main",
      recovery: "interrupted",
    });
    api.nextTurnQueue.list.mockResolvedValue({ revision: 9 });
    api.worktrees.recover.mockRejectedValue(new Error("Submodule initialization failed"));
    const threadId = ThreadId.makeUnsafe("retry-recovery");
    const banner = (
      <WorktreeMissingBanner
        threadId={threadId}
        worktreePath="/recovered"
        branch="feature"
        queueBlocked={queueBlocked}
      />
    );
    const first = await mount(banner);
    await first.getByRole("button", { name: "Retry recovery" }).click();
    await expect
      .element(first.getByRole("alert"))
      .toHaveTextContent("Submodule initialization failed");
    await first.unmount();
    // A fresh query cache models a reload after the failed request (or server restart).
    const reloaded = await mount(banner);
    await expect.element(reloaded.getByRole("button", { name: "Retry recovery" })).toBeEnabled();
    await reloaded.getByRole("button", { name: "Retry recovery" }).click();
    expect(api.worktrees.recover).toHaveBeenLastCalledWith({
      threadId,
      expectedQueueRevision: 9,
      action: "recreate",
    });
  },
);

it("offers recovery after a restart between switching to the project and clearing the barrier", async () => {
  api.worktrees.threadState.mockResolvedValue({
    worktreePath: null,
    branch: "main",
    directoryExists: true,
    registration: "none",
    branchExists: false,
    defaultBranch: null,
    recovery: "interrupted",
  });
  api.nextTurnQueue.list.mockResolvedValue({ revision: 12 });
  api.worktrees.recover.mockResolvedValue({});
  const threadId = ThreadId.makeUnsafe("local-interrupted");
  const screen = await mount(
    <WorktreeMissingBanner threadId={threadId} worktreePath={null} branch="main" />,
  );
  await screen.getByRole("button", { name: "Continue in project checkout" }).click();
  expect(api.worktrees.recover).toHaveBeenCalledWith({
    threadId,
    action: "useProjectCheckout",
    expectedQueueRevision: 12,
  });
});

it("allows cancelling a running preparation", async () => {
  api.worktrees.threadState.mockResolvedValue({
    worktreePath: "/recovering",
    branch: "feature",
    directoryExists: true,
    registration: "matching",
    branchExists: true,
    defaultBranch: "main",
    recovery: "running",
  });
  api.nextTurnQueue.list.mockResolvedValue({ revision: 12 });
  api.worktrees.recover.mockResolvedValue({});
  const threadId = ThreadId.makeUnsafe("cancel-recovery");
  const screen = await mount(
    <WorktreeMissingBanner threadId={threadId} worktreePath="/recovering" />,
  );
  await screen.getByRole("button", { name: "Cancel preparation" }).click();
  expect(api.worktrees.recover).toHaveBeenCalledWith({
    threadId,
    action: "cancel",
    expectedQueueRevision: 12,
  });
});
