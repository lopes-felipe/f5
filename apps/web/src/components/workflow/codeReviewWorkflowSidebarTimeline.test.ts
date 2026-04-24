import { describe, expect, it } from "vitest";
import {
  CodeReviewWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflow,
} from "@t3tools/contracts";

import { deriveCodeReviewTimelinePhases } from "./codeReviewWorkflowSidebarTimeline";

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

describe("deriveCodeReviewTimelinePhases", () => {
  it("treats pending_start consolidation as an active merge phase", () => {
    const phases = deriveCodeReviewTimelinePhases(
      makeWorkflow({
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
          status: "pending_start",
        },
      }),
    );

    expect(phases[1]!.id).toBe("merge");
    expect(phases[1]!.state).toBe("active");
    expect(phases[1]!.steps[0]!.state).toBe("active");
    expect(phases[1]!.steps[0]!.threadId).toBeNull();
  });
});
