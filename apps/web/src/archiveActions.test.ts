import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "./types";
import { deleteThreadsWithCleanup } from "./archiveActions";
import { createComposerMention } from "./composer-editor-mentions";
import { useComposerMentionHistoryStore } from "./composerMentionHistoryStore";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  confirm: vi.fn(),
  close: vi.fn(),
  request: vi.fn(),
}));
vi.mock("./nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: mocks.dispatch },
    dialogs: { confirm: mocks.confirm },
    terminal: { close: mocks.close },
  }),
}));
vi.mock("./worktreeRemovalDialogStore", () => ({
  useWorktreeRemovalDialogStore: { getState: () => ({ request: mocks.request }) },
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function harness(order: string[]) {
  mocks.dispatch.mockReset();
  mocks.request.mockReset().mockResolvedValue(undefined);
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
    useComposerMentionHistoryStore.setState({
      entries: ["a", "b"].map((threadId) => ({
        threadId,
        messageId: "m",
        promptLength: 9,
        mentions: [createComposerMention("src/a.ts", 0)],
      })),
    });
    const rejection = new Error("Deletion rejected");
    mocks.dispatch.mockImplementation(async (command) => {
      if (command.threadId === "a") throw rejection;
    });
    const result = await deleteThreadsWithCleanup(input);
    expect(result.succeeded).toEqual(["b"]);
    expect(
      useComposerMentionHistoryStore.getState().entries.map((entry) => entry.threadId),
    ).toEqual(["a"]);
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
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith([{ projectId: "project", path: "/repo/worktree" }]);
  });
  it("batches three deleted conversations and two orphan worktrees into one dialog", async () => {
    const input = harness(["a", "b", "c"]);
    input.threads.push({
      ...input.threads[0]!,
      id: ThreadId.makeUnsafe("c"),
      worktreePath: "/repo/second",
    });
    mocks.dispatch.mockResolvedValue(undefined);
    await deleteThreadsWithCleanup(input);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith([
      { projectId: "project", path: "/repo/worktree" },
      { projectId: "project", path: "/repo/second" },
    ]);
  });
});
