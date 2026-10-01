import {
  CommandId,
  ThreadId,
  WORKTREE_SETUP_STAGE_ORDER,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";

export function makeWorktreeSetupSnapshot(
  overrides: Partial<WorktreeSetupSnapshot> = {},
): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.makeUnsafe("setup-thread"),
    operationId: "op-1",
    itemId: CommandId.makeUnsafe("item-1"),
    phase: "running",
    startedAt: "2026-10-01T10:00:00.000Z",
    endedAt: null,
    request: {
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "f5/feature",
      runSetupScript: true,
      requireWorktree: false,
    },
    baseRef: null,
    baseSha: null,
    worktreePath: null,
    createdBranch: false,
    createdWorktree: false,
    setupScript: null,
    agentStarted: false,
    stages: WORKTREE_SETUP_STAGE_ORDER.map((id) => ({
      id,
      status: "pending",
      startedAt: null,
      endedAt: null,
      percent: null,
      detail: null,
      tail: [],
    })),
    error: null,
    sequence: 1,
    ...overrides,
  };
}
