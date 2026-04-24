import { describe, expect, it } from "vitest";

import {
  CodeReviewWorkflowId,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflow,
  type PlanningWorkflow,
} from "@t3tools/contracts";

import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import {
  getMostRecentProject,
  getMostRecentThreadForProject,
  sortProjectsByActivity,
  sortThreadsByActivity,
} from "./threadOrdering";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project-1",
    model: "gpt-5-codex",
    createdAt: "2026-03-01T00:00:00.000Z",
    expanded: true,
    scripts: [],
    memories: [],
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

function makePlanningWorkflow(overrides: Partial<PlanningWorkflow> = {}): PlanningWorkflow {
  return {
    id: PlanningWorkflowId.makeUnsafe("planning-workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Ship the feature",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5-codex" },
      authorThreadId: ThreadId.makeUnsafe("planning-author-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      authorThreadId: ThreadId.makeUnsafe("planning-author-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeCodeReviewWorkflow(overrides: Partial<CodeReviewWorkflow> = {}): CodeReviewWorkflow {
  return {
    id: CodeReviewWorkflowId.makeUnsafe("code-review-workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Code review",
    slug: "code-review",
    reviewPrompt: "Review the branch",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("code-reviewer-a"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      threadId: ThreadId.makeUnsafe("code-reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("threadOrdering", () => {
  it("sorts threads by lastInteractionAt, then createdAt, then thread id", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-03-01T00:00:00.000Z",
        lastInteractionAt: "2026-03-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        createdAt: "2026-03-01T00:00:00.000Z",
        lastInteractionAt: "2026-03-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-03-03T00:00:00.000Z",
        lastInteractionAt: "2026-03-02T00:00:00.000Z",
      }),
    ];

    expect(sortThreadsByActivity(threads).map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-3",
      "thread-1",
    ]);
  });

  it("sorts projects by hottest child activity, then createdAt, then project id", () => {
    const projects = [
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-3"),
        cwd: "/tmp/project-3",
        name: "Project 3",
        createdAt: "2026-03-03T00:00:00.000Z",
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-2"),
        cwd: "/tmp/project-2",
        name: "Project 2",
        createdAt: "2026-03-03T00:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        lastInteractionAt: "2026-03-02T00:00:00.000Z",
      }),
    ];

    expect(sortProjectsByActivity(projects, threads, [], []).map((project) => project.id)).toEqual([
      "project-3",
      "project-2",
      "project-1",
    ]);
  });

  it("ignores archived threads for most recent thread selection", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const activeThread = makeThread({
      id: ThreadId.makeUnsafe("thread-active"),
      projectId,
      lastInteractionAt: "2026-03-02T00:00:00.000Z",
    });
    const archivedThread = makeThread({
      id: ThreadId.makeUnsafe("thread-archived"),
      projectId,
      archivedAt: "2026-03-03T00:00:00.000Z",
      lastInteractionAt: "2026-03-04T00:00:00.000Z",
    });

    expect(
      getMostRecentThreadForProject(projectId, [activeThread, archivedThread], [], [])?.id,
    ).toBe(activeThread.id);
  });

  it("ignores planning workflow child threads when the parent workflow is archived", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const visibleThread = makeThread({
      id: ThreadId.makeUnsafe("thread-visible"),
      projectId,
      lastInteractionAt: "2026-03-02T00:00:00.000Z",
    });
    const hiddenThread = makeThread({
      id: ThreadId.makeUnsafe("planning-author-a"),
      projectId,
      lastInteractionAt: "2026-03-04T00:00:00.000Z",
    });
    const archivedWorkflow = makePlanningWorkflow({
      projectId,
      archivedAt: "2026-03-03T00:00:00.000Z",
    });

    expect(
      getMostRecentThreadForProject(
        projectId,
        [visibleThread, hiddenThread],
        [archivedWorkflow],
        [],
      ),
    )?.toMatchObject({ id: visibleThread.id });
  });

  it("ignores code review workflow child threads when the parent workflow is archived", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const visibleThread = makeThread({
      id: ThreadId.makeUnsafe("thread-visible"),
      projectId,
      lastInteractionAt: "2026-03-02T00:00:00.000Z",
    });
    const hiddenThread = makeThread({
      id: ThreadId.makeUnsafe("code-reviewer-a"),
      projectId,
      lastInteractionAt: "2026-03-04T00:00:00.000Z",
    });
    const archivedWorkflow = makeCodeReviewWorkflow({
      projectId,
      archivedAt: "2026-03-03T00:00:00.000Z",
    });

    expect(
      getMostRecentThreadForProject(
        projectId,
        [visibleThread, hiddenThread],
        [],
        [archivedWorkflow],
      ),
    )?.toMatchObject({ id: visibleThread.id });
  });

  it("ignores hidden archived-workflow activity when choosing the most recent project", () => {
    const projects = [
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-2"),
        cwd: "/tmp/project-2",
        name: "Project 2",
        createdAt: "2026-03-02T00:00:00.000Z",
      }),
    ];
    const visibleThread = makeThread({
      id: ThreadId.makeUnsafe("thread-visible"),
      projectId: ProjectId.makeUnsafe("project-2"),
      lastInteractionAt: "2026-03-03T00:00:00.000Z",
    });
    const hiddenThread = makeThread({
      id: ThreadId.makeUnsafe("planning-author-a"),
      projectId: ProjectId.makeUnsafe("project-1"),
      lastInteractionAt: "2026-03-05T00:00:00.000Z",
    });
    const archivedWorkflow = makePlanningWorkflow({
      projectId: ProjectId.makeUnsafe("project-1"),
      archivedAt: "2026-03-04T00:00:00.000Z",
    });

    expect(
      getMostRecentProject(projects, [visibleThread, hiddenThread], [archivedWorkflow], [])?.id,
    ).toBe("project-2");
  });
});
