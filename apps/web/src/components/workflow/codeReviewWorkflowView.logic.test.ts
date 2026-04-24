import { describe, expect, it } from "vitest";
import {
  CodeReviewWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflow,
} from "@t3tools/contracts";

import {
  canRetryConsolidation,
  canRetryFailedReviewers,
  statusLabel,
} from "./codeReviewWorkflowView.logic";

const NOW = "2026-04-02T12:00:00.000Z";

function makeWorkflow(overrides: Partial<CodeReviewWorkflow> = {}): CodeReviewWorkflow {
  return {
    id: CodeReviewWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Code review",
    slug: "code-review",
    reviewPrompt: "Review this branch",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("codeReviewWorkflowView.logic", () => {
  it("hides retry actions while the workflow is still pending", () => {
    const workflow = makeWorkflow();
    expect(statusLabel(workflow)).toBe("Pending");
    expect(canRetryFailedReviewers(workflow)).toBe(false);
    expect(canRetryConsolidation(workflow)).toBe(false);
  });

  it("shows reviewer retry only when a reviewer failed", () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer failed",
      },
    });
    expect(statusLabel(workflow)).toBe("Error");
    expect(canRetryFailedReviewers(workflow)).toBe(true);
    expect(canRetryConsolidation(workflow)).toBe(false);
  });

  it("shows merge retry only when consolidation failed after both reviews completed", () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "error",
        error: "Merge failed",
      },
    });
    expect(canRetryFailedReviewers(workflow)).toBe(false);
    expect(canRetryConsolidation(workflow)).toBe(true);
  });
});
