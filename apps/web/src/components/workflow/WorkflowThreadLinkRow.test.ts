import { describe, expect, it } from "vitest";

import { resolveWorkflowThreadRowState } from "./WorkflowThreadLinkRow";

const BASE_THREAD = {
  id: "thread-1" as never,
  codexThreadId: null,
  projectId: "project-1" as never,
  title: "Workflow Branch A",
  model: "gpt-5",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: {
    provider: "codex" as const,
    status: "running" as const,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    orchestrationStatus: "running" as const,
  },
  messages: [],
  commandExecutions: [],
  proposedPlans: [],
  tasks: [],
  tasksTurnId: null,
  tasksUpdatedAt: null,
  error: null,
  createdAt: "2026-03-09T10:00:00.000Z",
  archivedAt: null,
  lastInteractionAt: "2026-03-09T10:00:00.000Z",
  estimatedContextTokens: null,
  modelContextWindowTokens: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
  detailsLoaded: true,
  sessionNotes: null,
  threadReferences: [],
};

describe("resolveWorkflowThreadRowState", () => {
  it("renders a title and visible pill when the thread has a visible status", () => {
    const row = resolveWorkflowThreadRowState({
      thread: BASE_THREAD,
      threadTitleDisplay: "Branch A",
      fallbackLabel: "Branch A: running",
    });

    expect(row.title).toBe("Branch A");
    expect(row.pill?.label).toBe("Working");
  });

  it("renders the title without a pill when the thread has no visible status", () => {
    const row = resolveWorkflowThreadRowState({
      thread: {
        ...BASE_THREAD,
        session: {
          ...BASE_THREAD.session,
          status: "ready",
          orchestrationStatus: "ready",
        },
        lastVisitedAt: "2026-03-09T10:10:00.000Z",
      },
      threadTitleDisplay: "Branch A",
      fallbackLabel: "Branch A: ready",
    });

    expect(row.title).toBe("Branch A");
    expect(row.pill).toBeNull();
  });

  it("falls back cleanly when the referenced thread is missing", () => {
    const row = resolveWorkflowThreadRowState({
      thread: null,
      fallbackLabel: "Branch A: revised",
    });

    expect(row).toEqual({
      title: "Branch A: revised",
      pill: null,
    });
  });

  it("preserves trimmed planning workflow display titles", () => {
    const row = resolveWorkflowThreadRowState({
      thread: BASE_THREAD,
      threadTitleDisplay: "Branch A",
      fallbackLabel: "Branch A: running",
    });

    expect(row.title).toBe("Branch A");
  });
});
