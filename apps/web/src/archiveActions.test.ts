import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "./types";
import { deleteThreadsWithCleanup } from "./archiveActions";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), confirm: vi.fn(), close: vi.fn() }));
vi.mock("./nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: mocks.dispatch },
    dialogs: { confirm: mocks.confirm },
    terminal: { close: mocks.close },
  }),
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function harness(order: string[]) {
  mocks.dispatch.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.close.mockReset().mockResolvedValue(undefined);
  const threads = ["a", "b"].map(
    (id) =>
      ({
        id: ThreadId.makeUnsafe(id),
        projectId: ProjectId.makeUnsafe("project"),
        worktreePath: "/repo/worktree",
        session: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        lastInteractionAt: "2026-01-01T00:00:00Z",
      }) as Thread,
  );
  return {
    threadIds: order.map(ThreadId.makeUnsafe),
    threads,
    projects: [{ id: ProjectId.makeUnsafe("project"), cwd: "/repo" }] as Project[],
    activeThreadId: ThreadId.makeUnsafe("b"),
    clearComposerDraftForThread: vi.fn(),
    clearProjectDraftThreadById: vi.fn(),
    clearTerminalState: vi.fn(),
    navigateToThread: vi.fn(),
    navigateHome: vi.fn(),
    removeWorktree: vi.fn(),
  };
}

describe("bulk deletion cleanup", () => {
  it.each([
    ["a", "b"],
    ["b", "a"],
  ])("keeps shared worktrees after partial failure (%s then %s)", async (first, second) => {
    const input = harness([first, second]);
    const rejection = new Error("Deletion rejected");
    mocks.dispatch.mockImplementation(async (command) => {
      if (command.threadId === "a") throw rejection;
    });
    const result = await deleteThreadsWithCleanup(input);
    expect(result.succeeded).toEqual(["b"]);
    expect(result.failures).toEqual([{ threadId: "a", error: rejection }]);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(input.removeWorktree).not.toHaveBeenCalled();
    expect(input.navigateToThread).toHaveBeenCalledWith("a");
    expect(input.clearComposerDraftForThread).not.toHaveBeenCalledWith("a");
    expect(mocks.close).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "a" }));
  });

  it("offers shared-worktree cleanup once, only after both deletions succeed", async () => {
    const input = harness(["b", "a"]);
    mocks.dispatch.mockResolvedValue(undefined);
    mocks.confirm.mockImplementation(async () => {
      expect(mocks.dispatch).toHaveBeenCalledTimes(2);
      return true;
    });
    await deleteThreadsWithCleanup(input);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(input.removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      path: "/repo/worktree",
      force: false,
    });
  });
  it("rechecks surviving threads after the worktree confirmation", async () => {
    const input = harness(["a", "b"]);
    let current = input.threads;
    mocks.dispatch.mockResolvedValue(undefined);
    mocks.confirm.mockImplementation(async () => {
      current = [...current, { ...current[0]!, id: ThreadId.makeUnsafe("new-thread") }];
      return true;
    });
    await deleteThreadsWithCleanup({ ...input, getThreads: () => current });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(input.removeWorktree).not.toHaveBeenCalled();
  });
});
