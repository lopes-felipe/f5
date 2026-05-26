import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";

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
  applyProviderAdvisoriesToServerConfig,
  pruneDraftThreadsForCurrentProjects,
  reconcileDraftThreadsAfterStartupSnapshot,
} from "./__root";

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver: "codex" | "claudeAgent";
  readonly versionAdvisory?: ServerProviderVersionAdvisory;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-05-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.versionAdvisory ? { versionAdvisory: input.versionAdvisory } : {}),
  };
}

function makeAdvisory(latestVersion: string): ServerProviderVersionAdvisory {
  return {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion,
    updateCommand: {
      executable: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
      channel: "npm",
    },
    checkedAt: "2026-05-26T00:00:00.000Z",
    message: `Installed v1.0.0 · latest v${latestVersion}`,
  };
}

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

describe("__root provider advisory cache patch", () => {
  it("adds, updates, and strips provider advisories using authoritative payload entries", () => {
    const staleAdvisory = makeAdvisory("1.1.0");
    const nextAdvisory = makeAdvisory("1.2.0");
    const existing = {
      providers: [
        makeProvider({
          instanceId: "codex",
          driver: "codex",
          versionAdvisory: staleAdvisory,
        }),
        makeProvider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          versionAdvisory: staleAdvisory,
        }),
      ],
    } as unknown as ServerConfig;

    const patched = applyProviderAdvisoriesToServerConfig(existing, {
      advisories: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          versionAdvisory: nextAdvisory,
        },
      ],
    });

    expect(patched?.providers[0]?.versionAdvisory?.latestVersion).toBe("1.2.0");
    expect(patched?.providers[1]?.versionAdvisory).toBeUndefined();
  });

  it("leaves an empty cache result unchanged", () => {
    expect(
      applyProviderAdvisoriesToServerConfig(undefined, {
        advisories: [],
      }),
    ).toBeUndefined();
  });
});
