import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import { resolveLatestWorkHeading, resolveWorkflowStepCardModel } from "./WorkflowStepCard";
import type { WorkflowTimelineStep } from "./workflowTimelineTypes";

const BASE_THREAD: Thread = {
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
  estimatedThinkingTokens: null,
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

function makeStep(overrides: Partial<WorkflowTimelineStep> = {}): WorkflowTimelineStep {
  return {
    key: "author-a",
    label: "Branch A",
    threadId: BASE_THREAD.id,
    state: "active",
    modelSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
    ...overrides,
  };
}

const TOOL_ACTIVITY: OrchestrationThreadActivity = {
  id: "activity-1" as never,
  tone: "tool",
  kind: "tool.completed",
  summary: "Ran command",
  payload: { itemType: "command_execution", command: "bun run lint" },
  turnId: null,
  createdAt: "2026-03-09T10:01:00.000Z",
};

describe("resolveWorkflowStepCardModel", () => {
  it("labels the step by its role, not the thread title", () => {
    const model = resolveWorkflowStepCardModel({ step: makeStep(), thread: BASE_THREAD });
    expect(model.label).toBe("Branch A");
  });

  it("shows a visible thread status", () => {
    const model = resolveWorkflowStepCardModel({ step: makeStep(), thread: BASE_THREAD });
    expect(model.pill?.label).toBe("Working");
  });

  it("drops the pill when the thread has no visible status", () => {
    const model = resolveWorkflowStepCardModel({
      step: makeStep(),
      thread: {
        ...BASE_THREAD,
        session: { ...BASE_THREAD.session!, status: "ready", orchestrationStatus: "ready" },
        lastVisitedAt: "2026-03-09T10:10:00.000Z",
      },
    });
    expect(model.pill).toBeNull();
  });

  it("uses the thread's actual model once the thread exists", () => {
    const model = resolveWorkflowStepCardModel({ step: makeStep(), thread: BASE_THREAD });
    expect(model.model).toEqual({ model: "gpt-5", provider: null, sessionProviderName: "codex" });
  });

  it("falls back to the configured slot before the thread exists", () => {
    const model = resolveWorkflowStepCardModel({
      step: makeStep({ threadId: null, state: "pending" }),
      thread: null,
    });
    expect(model).toEqual({
      label: "Branch A",
      pill: null,
      model: { model: "claude-sonnet-4-5", provider: "claudeAgent", sessionProviderName: null },
      activity: null,
    });
  });

  it("has no model when neither a thread nor a slot is known", () => {
    const model = resolveWorkflowStepCardModel({
      step: makeStep({ threadId: null, modelSlot: null }),
      thread: undefined,
    });
    expect(model.model).toBeNull();
  });

  it("adds the latest work heading only for running steps when asked", () => {
    const thread = { ...BASE_THREAD, activities: [TOOL_ACTIVITY] };
    expect(
      resolveWorkflowStepCardModel({ step: makeStep(), thread, includeActivity: true }).activity,
    ).toBe(resolveLatestWorkHeading(thread));
    expect(resolveLatestWorkHeading(thread)).not.toBeNull();
    expect(resolveWorkflowStepCardModel({ step: makeStep(), thread }).activity).toBeNull();
    expect(
      resolveWorkflowStepCardModel({
        step: makeStep({ state: "completed" }),
        thread,
        includeActivity: true,
      }).activity,
    ).toBeNull();
  });
});

describe("resolveLatestWorkHeading", () => {
  it("is null for a thread without activity", () => {
    expect(resolveLatestWorkHeading(BASE_THREAD)).toBeNull();
  });
});
