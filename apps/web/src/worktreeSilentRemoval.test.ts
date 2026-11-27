import { ProjectId, type WorktreesInspectResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), remove: vi.fn(), toast: vi.fn() }));
vi.mock("./nativeApi", () => ({
  readNativeApi: () => ({ worktrees: { inspect: mocks.inspect, remove: mocks.remove } }),
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { useWorktreeRemovalDialogStore } from "./worktreeRemovalDialogStore";
import { offerWorktreeRemovalAfterDeletion } from "./worktreeSilentRemoval";

const projectId = ProjectId.makeUnsafe("project");
const row = (path: string) => ({ projectId, path });
const inspection = (overrides: Partial<WorktreesInspectResult> = {}): WorktreesInspectResult => ({
  exists: true,
  registration: null,
  blockedReasons: [],
  linkedThreads: [],
  deletedThreadClaims: [],
  branch: "feature",
  headSha: "abc",
  branchExists: true,
  branchMerged: false,
  branchPushed: false,
  branchUpstreamGone: false,
  branchDeletable: false,
  branchBlockedReason: null,
  safeToRemoveSilently: true,
  ...overrides,
});
const removed = { removed: true, branchDeleted: false, blockedReasons: [] };
const dialogRows = () =>
  useWorktreeRemovalDialogStore.getState().requests.map((request) => request.rows);

beforeEach(() => {
  vi.clearAllMocks();
  useWorktreeRemovalDialogStore.setState({ requests: [], silentRemovals: 0 });
});

describe("worktrees of deleted threads", () => {
  it("removes the safe ones without a dialog, keeps their branches and says so", async () => {
    mocks.inspect.mockResolvedValue(inspection());
    mocks.remove.mockResolvedValue(removed);
    await offerWorktreeRemovalAfterDeletion([row("/wt/a"), row("/wt/b")]);
    // `silent` has the server check again, under its locks, that nobody would be asked.
    expect(mocks.remove.mock.calls).toEqual([
      [{ ...row("/wt/a"), deleteBranch: false, expectedHead: "abc", silent: true }],
      [{ ...row("/wt/b"), deleteBranch: false, expectedHead: "abc", silent: true }],
    ]);
    expect(dialogRows()).toEqual([]);
    expect(mocks.toast.mock.calls).toEqual([
      [{ type: "success", title: "Removed 2 worktrees · branches kept" }],
    ]);
    // Open lists refresh.
    expect(useWorktreeRemovalDialogStore.getState().silentRemovals).toBe(2);
  });

  it("asks only about the worktrees that are not safe to remove silently", async () => {
    mocks.inspect.mockImplementation(async ({ path }: { path: string }) =>
      inspection({ safeToRemoveSilently: path === "/wt/clean" }),
    );
    mocks.remove.mockResolvedValue(removed);
    void offerWorktreeRemovalAfterDeletion([row("/wt/clean"), row("/wt/env"), row("/wt/dirty")]);
    await vi.waitFor(() => expect(dialogRows()).toEqual([[row("/wt/env"), row("/wt/dirty")]]));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls).toEqual([
      [{ type: "success", title: "Removed 1 worktree · branch kept" }],
    ]);
  });

  it("leaves a worktree for the dialog when the server refuses or the check fails", async () => {
    mocks.inspect.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/wt/offline") throw new Error("offline");
      return inspection();
    });
    mocks.remove.mockResolvedValue({
      removed: false,
      branchDeleted: false,
      blockedReasons: ["it has uncommitted changes (including untracked files)"],
    });
    void offerWorktreeRemovalAfterDeletion([row("/wt/changed"), row("/wt/offline")]);
    await vi.waitFor(() =>
      expect(dialogRows()).toEqual([[row("/wt/changed"), row("/wt/offline")]]),
    );
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(useWorktreeRemovalDialogStore.getState().silentRemovals).toBe(0);
  });

  it("clears a worktree that was already off disk without announcing a removal", async () => {
    mocks.inspect.mockResolvedValue(inspection({ exists: false }));
    mocks.remove.mockResolvedValue(removed);
    await offerWorktreeRemovalAfterDeletion([row("/wt/gone")]);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(dialogRows()).toEqual([]);
    expect(mocks.toast).not.toHaveBeenCalled();
    // Nothing to announce, but the registration is gone: open lists refresh.
    expect(useWorktreeRemovalDialogStore.getState().silentRemovals).toBe(1);
  });

  it("checks several worktrees at once, and asks about the rest in their order", async () => {
    const paths = Array.from({ length: 9 }, (_, index) => `/wt/${index}`);
    let running = 0;
    let most = 0;
    mocks.inspect.mockImplementation(async ({ path }: { path: string }) => {
      most = Math.max(most, ++running);
      // Later rows answer first, so order cannot come from timing.
      await new Promise((resolve) => setTimeout(resolve, 20 - Number(path.slice(4)) * 2));
      running--;
      return inspection({ safeToRemoveSilently: Number(path.slice(4)) % 3 === 0 });
    });
    mocks.remove.mockResolvedValue(removed);
    void offerWorktreeRemovalAfterDeletion(paths.map(row));
    const kept = paths.filter((_, index) => index % 3 !== 0).map(row);
    await vi.waitFor(() => expect(dialogRows()).toEqual([kept]));
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    expect(mocks.toast.mock.calls).toEqual([
      [{ type: "success", title: "Removed 3 worktrees · branches kept" }],
    ]);
  });
});

describe("manual removal", () => {
  it("always opens the dialog", () => {
    void useWorktreeRemovalDialogStore.getState().request([row("/wt/a")]);
    expect(dialogRows()).toEqual([[row("/wt/a")]]);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
