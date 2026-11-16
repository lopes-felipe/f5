import { ProjectId, ThreadId, PlanningWorkflowId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "./types";
import { deleteThreadsWithCleanup, deleteWorkflow } from "./archiveActions";
import { useStore } from "./store";
import { createComposerMention } from "./composer-editor-mentions";
import { useComposerMentionHistoryStore } from "./composerMentionHistoryStore";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  confirm: vi.fn(),
  close: vi.fn(),
  request: vi.fn(),
  deleteWorkflow: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("./nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: mocks.dispatch,
      deleteWorkflow: mocks.deleteWorkflow,
      deleteCodeReviewWorkflow: mocks.deleteWorkflow,
      deleteInvestigationWorkflow: mocks.deleteWorkflow,
    },
    dialogs: { confirm: mocks.confirm },
    terminal: { close: mocks.close },
  }),
}));
vi.mock("./worktreeRemovalDialogStore", () => ({
  useWorktreeRemovalDialogStore: { getState: () => ({ request: mocks.request }) },
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

function harness(order: string[]) {
  useStore.setState({ backendGeneration: (useStore.getState().backendGeneration ?? 0) + 1 });
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
  it.each(["snoozed", "settled", "archived"] as const)(
    "skips a %s survivor when deleting the open thread",
    async (state) => {
      const input = harness(["b"]);
      const parked = input.threads[0]!;
      if (state === "snoozed") parked.snoozedUntil = "2099-01-01T00:00:00Z";
      if (state === "settled") parked.settledAt = "2026-01-01T00:00:00Z";
      if (state === "archived") parked.archivedAt = "2026-01-01T00:00:00Z";
      input.threads.push({
        ...parked,
        id: ThreadId.makeUnsafe("visible"),
        snoozedUntil: "2020-01-01T00:00:00Z",
        settledAt: null,
        archivedAt: null,
        lastInteractionAt: "2025-01-01T00:00:00Z",
      });
      mocks.dispatch.mockResolvedValue(undefined);
      await deleteThreadsWithCleanup(input);
      expect(input.navigateToThread).toHaveBeenCalledWith("visible");
      input.navigateToThread.mockClear();
      input.threads.pop();
      await deleteThreadsWithCleanup(input);
      expect(input.navigateToThread).not.toHaveBeenCalled();
      expect(input.navigateHome).toHaveBeenCalledOnce();
    },
  );

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
  it.each([
    ["/repo/worktree/", "/repo/worktree"],
    ["C:\\Repo\\Worktree", "c:/repo/worktree/"],
  ])("offers one removal row for equivalent paths %s and %s", async (firstPath, secondPath) => {
    const input = harness(["a", "b"]);
    input.threads[0]!.worktreePath = firstPath;
    input.threads[1]!.worktreePath = secondPath;
    mocks.dispatch.mockResolvedValue(undefined);

    const result = await deleteThreadsWithCleanup(input);

    expect(result.succeeded).toEqual(["a", "b"]);
    expect(result.failures).toEqual([]);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith([{ projectId: "project", path: firstPath }]);
  });

  it("batches three deleted conversations and two orphan worktrees into one dialog", async () => {
    const input = harness(["a", "b", "c"]);
    input.threads.push({
      ...input.threads[0]!,
      id: ThreadId.makeUnsafe("c"),
      worktreePath: "/repo/second",
    });
    mocks.dispatch.mockResolvedValue(undefined);
    // Deletion must finish while the removal dialog remains open.
    mocks.request.mockImplementation(() => new Promise<void>(() => {}));
    await deleteThreadsWithCleanup(input);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith([
      { projectId: "project", path: "/repo/worktree" },
      { projectId: "project", path: "/repo/second" },
    ]);
  });
});

describe("workflow deletion cleanup", () => {
  function setup() {
    const input = harness(["a", "b"]);
    useStore.setState({ threads: input.threads, projects: input.projects });
    mocks.deleteWorkflow.mockReset();
    mocks.toast.mockReset();
    return input;
  }
  it.each(["planning", "codeReview", "investigation"] as const)(
    "cleans only committed %s children and offers one shared-worktree prompt",
    async (workflowType) => {
      setup();
      mocks.deleteWorkflow.mockImplementation(async () => {
        // Events can arrive before the delete response; metadata must survive them.
        useStore.setState({ threads: [] });
        return { deletedThreadIds: ["a", "b", "a"] };
      });
      await deleteWorkflow({
        workflowId: PlanningWorkflowId.makeUnsafe("workflow"),
        workflowTitle: "Workflow",
        workflowType,
      });
      expect(mocks.deleteWorkflow).toHaveBeenCalledWith({
        workflowId: "workflow",
        deleteThreads: true,
      });
      expect(mocks.close).toHaveBeenCalledTimes(2);
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith([
        { projectId: "project", path: "/repo/worktree" },
      ]);
    },
  );
  it("preserves a worktree used by a current surviving thread", async () => {
    setup();
    mocks.deleteWorkflow.mockResolvedValue({ deletedThreadIds: ["a"] });
    await deleteWorkflow({
      workflowId: PlanningWorkflowId.makeUnsafe("workflow"),
      workflowTitle: "Workflow",
      workflowType: "planning",
    });
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith({ threadId: "a", deleteHistory: true });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["cancel", "reject", "older server"] as const)(
    "does not guess children or prompt after %s",
    async (outcome) => {
      setup();
      if (outcome === "cancel") mocks.confirm.mockResolvedValue(false);
      else if (outcome === "reject")
        mocks.deleteWorkflow.mockRejectedValue(new Error("Shared owner"));
      else mocks.deleteWorkflow.mockResolvedValue(undefined);
      await deleteWorkflow({
        workflowId: PlanningWorkflowId.makeUnsafe("workflow"),
        workflowTitle: "Workflow",
        workflowType: "planning",
      });
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.request).not.toHaveBeenCalled();
      if (outcome === "cancel") expect(mocks.deleteWorkflow).not.toHaveBeenCalled();
      if (outcome === "reject")
        expect(mocks.toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Failed to delete workflow" }),
        );
    },
  );
});
