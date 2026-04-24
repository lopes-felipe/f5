import { describe, expect, it } from "vitest";
import { PlanningWorkflowId, ProjectId, ThreadId, type PlanningWorkflow } from "@t3tools/contracts";

import {
  resolveApprovedMergedPlanMarkdown,
  threadIdsForWorkflow,
  workflowThreadDisplayTitle,
  workflowContainsThread,
} from "./workflowUtils";

function makeWorkflow(now = "2026-03-26T00:00:00.000Z"): PlanningWorkflow {
  return {
    id: PlanningWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Implement the thing",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5-codex" },
      authorThreadId: ThreadId.makeUnsafe("author-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-a"),
          outputFilePath: null,
          status: "completed",
          error: null,
          updatedAt: now,
        },
      ],
      status: "revised",
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
      status: "revised",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("merge-thread"),
      outputFilePath: "plans/workflow-merged.md",
      turnId: "merge-turn",
      approvedPlanId: "approved-plan",
      status: "manual_review",
      error: null,
      updatedAt: now,
    },
    implementation: {
      implementationSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("implementation-thread"),
      implementationTurnId: "implementation-turn",
      revisionTurnId: null,
      codeReviewEnabled: true,
      codeReviews: [
        {
          reviewerLabel: "Author A (codex:gpt-5-codex)",
          reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: ThreadId.makeUnsafe("implementation-review-a"),
          status: "running",
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
  };
}

describe("workflowUtils", () => {
  it("includes implementation and code review threads in threadIdsForWorkflow", () => {
    const workflow = makeWorkflow();

    expect(threadIdsForWorkflow(workflow)).toContain("implementation-thread");
    expect(threadIdsForWorkflow(workflow)).toContain("implementation-review-a");
  });

  it("recognizes implementation workflow threads", () => {
    const workflow = makeWorkflow();

    expect(workflowContainsThread(workflow, ThreadId.makeUnsafe("implementation-thread"))).toBe(
      true,
    );
    expect(workflowContainsThread(workflow, ThreadId.makeUnsafe("implementation-review-a"))).toBe(
      true,
    );
    expect(workflowContainsThread(workflow, ThreadId.makeUnsafe("missing-thread"))).toBe(false);
  });

  it("removes the workflow title prefix from grouped workflow thread titles", () => {
    const workflow = {
      ...makeWorkflow(),
      title: "Code review-only workflow",
    };

    expect(workflowThreadDisplayTitle(workflow, "Code review-only workflow Branch A")).toBe(
      "Branch A",
    );
    expect(workflowThreadDisplayTitle(workflow, "Branch B")).toBe("Branch B");
  });

  it("prefers the pinned approved merged plan markdown", () => {
    const workflow = makeWorkflow();
    const mergeThread = {
      proposedPlans: [
        { id: "older-plan", planMarkdown: "# Older" },
        { id: "approved-plan", planMarkdown: "# Approved" },
        { id: "latest-plan", planMarkdown: "# Latest" },
      ],
    };

    expect(resolveApprovedMergedPlanMarkdown(workflow, mergeThread)).toBe("# Approved");
  });
});
