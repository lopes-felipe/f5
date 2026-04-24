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
  isActiveWorkflow,
  isArchivedWorkflow,
  isDeletedWorkflow,
  partitionWorkflowsByArchive,
} from "./workflowArchive";

function makePlanningWorkflow(overrides: Partial<PlanningWorkflow> = {}): PlanningWorkflow {
  return {
    id: PlanningWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Ship the feature",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5-codex" },
      authorThreadId: ThreadId.makeUnsafe("author-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      authorThreadId: ThreadId.makeUnsafe("author-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeCodeReviewWorkflow(overrides: Partial<CodeReviewWorkflow> = {}): CodeReviewWorkflow {
  return {
    id: CodeReviewWorkflowId.makeUnsafe("workflow-2"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Code review",
    slug: "code-review",
    reviewPrompt: "Review the branch",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("workflowArchive", () => {
  it("detects archived and deleted workflows", () => {
    const active = makePlanningWorkflow();
    const archived = makePlanningWorkflow({ archivedAt: "2026-04-05T11:00:00.000Z" });
    const deleted = makeCodeReviewWorkflow({ deletedAt: "2026-04-05T12:00:00.000Z" });

    expect(isArchivedWorkflow(active)).toBe(false);
    expect(isArchivedWorkflow(archived)).toBe(true);
    expect(isDeletedWorkflow(active)).toBe(false);
    expect(isDeletedWorkflow(deleted)).toBe(true);
    expect(isActiveWorkflow(active)).toBe(true);
    expect(isActiveWorkflow(archived)).toBe(false);
    expect(isActiveWorkflow(deleted)).toBe(false);
  });

  it("partitions workflows by archived state only", () => {
    const active = makePlanningWorkflow();
    const archived = makeCodeReviewWorkflow({ archivedAt: "2026-04-05T11:00:00.000Z" });
    const deleted = makePlanningWorkflow({
      id: PlanningWorkflowId.makeUnsafe("workflow-3"),
      deletedAt: "2026-04-05T12:00:00.000Z",
    });

    const { activeWorkflows, archivedWorkflows } = partitionWorkflowsByArchive([
      active,
      archived,
      deleted,
    ]);

    expect(activeWorkflows).toEqual([active, deleted]);
    expect(archivedWorkflows).toEqual([archived]);
  });
});
