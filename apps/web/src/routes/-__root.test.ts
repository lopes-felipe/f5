import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearPromotedDraftThreads, getStoreState, pruneOrphanedDraftThreads } = vi.hoisted(() => ({
  clearPromotedDraftThreads: vi.fn(),
  getStoreState: vi.fn<() => { projects: Array<{ id: string }> }>(() => ({ projects: [] })),
  pruneOrphanedDraftThreads: vi.fn(),
}));

vi.mock("../composerDraftStore", () => ({
  clearPromotedDraftThreads,
  pruneOrphanedDraftThreads,
  useComposerDraftStore: {
    getState: () => ({
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    }),
  },
}));

vi.mock("../store", () => ({
  useStore: {
    getState: getStoreState,
  },
}));

import {
  pruneDraftThreadsForCurrentProjects,
  reconcileDraftThreadsAfterStartupSnapshot,
} from "./__root";

describe("__root draft cleanup helpers", () => {
  beforeEach(() => {
    clearPromotedDraftThreads.mockReset();
    pruneOrphanedDraftThreads.mockReset();
    getStoreState.mockReset();
    getStoreState.mockReturnValue({ projects: [] });
  });

  it("reconciles startup snapshots by pruning orphaned drafts before clearing promoted ones", () => {
    reconcileDraftThreadsAfterStartupSnapshot({
      snapshotSequence: 1,
      projects: [
        { id: "project-live", deletedAt: null },
        { id: "project-deleted", deletedAt: "2026-04-22T12:00:00.000Z" },
      ],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [{ id: "thread-1" }, { id: "thread-2" }],
      updatedAt: "2026-04-22T12:00:00.000Z",
    } as never);

    const pruneCallOrder = pruneOrphanedDraftThreads.mock.invocationCallOrder[0];
    const clearCallOrder = clearPromotedDraftThreads.mock.invocationCallOrder[0];

    expect(pruneOrphanedDraftThreads).toHaveBeenCalledWith(new Set(["project-live"]));
    expect(clearPromotedDraftThreads).toHaveBeenCalledWith(new Set(["thread-1", "thread-2"]));
    expect(pruneCallOrder).toBeDefined();
    expect(clearCallOrder).toBeDefined();
    expect(pruneCallOrder ?? 0).toBeLessThan(clearCallOrder ?? 0);
  });

  it("prunes orphaned drafts against the current store projects after project deletion", () => {
    getStoreState.mockReturnValue({
      projects: [{ id: "project-1" }, { id: "project-2" }],
    });

    pruneDraftThreadsForCurrentProjects();

    expect(pruneOrphanedDraftThreads).toHaveBeenCalledWith(new Set(["project-1", "project-2"]));
  });
});
