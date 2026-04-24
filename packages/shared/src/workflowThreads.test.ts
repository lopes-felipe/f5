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
  archivedWorkflowThreadIds,
  threadIdsForCodeReviewWorkflow,
  threadIdsForPlanningWorkflow,
} from "./workflowThreads";

function makePlanningWorkflow(
  overrides: Partial<PlanningWorkflow> = {},
  now = "2026-04-05T10:00:00.000Z",
): PlanningWorkflow {
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
      updatedAt: now,
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      authorThreadId: ThreadId.makeUnsafe("author-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-b"),
          outputFilePath: null,
          status: "completed",
          error: null,
          updatedAt: now,
        },
      ],
      status: "reviews_saved",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("merge-thread"),
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "manual_review",
      error: null,
      updatedAt: now,
    },
    implementation: {
      implementationSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("implementation-thread"),
      implementationTurnId: null,
      revisionTurnId: null,
      codeReviewEnabled: true,
      codeReviews: [
        {
          reviewerLabel: "Reviewer",
          reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("implementation-review"),
          status: "pending",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        },
      ],
      status: "code_reviews_requested",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    },
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeCodeReviewWorkflow(
  overrides: Partial<CodeReviewWorkflow> = {},
  now = "2026-04-05T10:00:00.000Z",
): CodeReviewWorkflow {
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
      updatedAt: now,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: now,
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("consolidation"),
      status: "running",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("workflowThreads", () => {
  it("collects all planning workflow thread ids", () => {
    expect(threadIdsForPlanningWorkflow(makePlanningWorkflow())).toEqual([
      "author-a",
      "author-b",
      "merge-thread",
      "review-b",
      "implementation-thread",
      "implementation-review",
    ]);
  });

  it("collects all code review workflow thread ids", () => {
    expect(threadIdsForCodeReviewWorkflow(makeCodeReviewWorkflow())).toEqual([
      "reviewer-a",
      "reviewer-b",
      "consolidation",
    ]);
  });

  it("collects thread ids owned by archived workflows", () => {
    const planningWorkflow = makePlanningWorkflow({ archivedAt: "2026-04-05T11:00:00.000Z" });
    const archivedCodeReview = makeCodeReviewWorkflow({
      archivedAt: "2026-04-05T11:30:00.000Z",
    });
    const activeCodeReview = makeCodeReviewWorkflow({
      id: CodeReviewWorkflowId.makeUnsafe("workflow-3"),
      reviewerA: {
        ...makeCodeReviewWorkflow().reviewerA,
        threadId: ThreadId.makeUnsafe("active-reviewer-a"),
      },
      reviewerB: {
        ...makeCodeReviewWorkflow().reviewerB,
        threadId: ThreadId.makeUnsafe("active-reviewer-b"),
      },
      consolidation: {
        ...makeCodeReviewWorkflow().consolidation,
        threadId: ThreadId.makeUnsafe("active-consolidation"),
      },
    });

    expect(
      archivedWorkflowThreadIds([planningWorkflow], [archivedCodeReview, activeCodeReview]),
    ).toEqual(
      new Set([
        "author-a",
        "author-b",
        "merge-thread",
        "review-b",
        "implementation-thread",
        "implementation-review",
        "reviewer-a",
        "reviewer-b",
        "consolidation",
      ]),
    );
  });
});
