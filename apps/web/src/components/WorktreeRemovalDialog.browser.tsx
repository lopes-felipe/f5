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
    <WorktreeMissingBanner threadId={ThreadId.makeUnsafe("queued")} queue />,
  );
  await expect.element(screen.getByRole("button", { name: "Recreate now" })).toBeVisible();
});
