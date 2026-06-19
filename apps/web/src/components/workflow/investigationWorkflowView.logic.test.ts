import { describe, expect, it } from "vitest";
import {
  InvestigationWorkflowId,
  ProjectId,
  ThreadId,
  type InvestigationWorkflow,
} from "@t3tools/contracts";

import { deriveInvestigationTimelinePhases } from "./investigationWorkflowSidebarTimeline";
import {
  canRetryFailedInvestigationPhase,
  canRetrySelfReview,
  canRetrySynthesis,
  statusLabel,
} from "./investigationWorkflowView.logic";

const NOW = "2026-04-12T12:00:00.000Z";

function makeWorkflow(overrides: Partial<InvestigationWorkflow> = {}): InvestigationWorkflow {
  return {
    id: InvestigationWorkflowId.makeUnsafe("investigation-workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Investigation workflow",
    slug: "investigation-workflow",
    problemPrompt: "Investigate the issue",
    branch: null,
    selfReviewEnabled: false,
    investigatorA: {
      label: "Investigator A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      investigationThreadId: ThreadId.makeUnsafe("investigator-a"),
      investigationStatus: "completed",
      investigationTurnId: "turn-investigation-a",
      investigationMessageId: "message-investigation-a",
      crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
      crossReviewStatus: "completed",
      crossReviewTurnId: "turn-cross-review-a",
      crossReviewMessageId: "message-cross-review-a",
      selfReviewThreadId: null,
      selfReviewStatus: "not_started",
      selfReviewTurnId: null,
      selfReviewMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    investigatorB: {
      label: "Investigator B",
      slot: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      investigationThreadId: ThreadId.makeUnsafe("investigator-b"),
      investigationStatus: "completed",
      investigationTurnId: "turn-investigation-b",
      investigationMessageId: "message-investigation-b",
      crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
      crossReviewStatus: "completed",
      crossReviewTurnId: "turn-cross-review-b",
      crossReviewMessageId: "message-cross-review-b",
      selfReviewThreadId: null,
      selfReviewStatus: "not_started",
      selfReviewTurnId: null,
      selfReviewMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    synthesis: {
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

describe("investigationWorkflowView.logic", () => {
  it("omits own-model review phase when disabled", () => {
    expect(deriveInvestigationTimelinePhases(makeWorkflow()).map((phase) => phase.id)).toEqual([
      "investigation",
      "cross-review",
      "synthesis",
    ]);
  });

  it("shows own-model review phase when enabled", () => {
    expect(
      deriveInvestigationTimelinePhases(makeWorkflow({ selfReviewEnabled: true })).map(
        (phase) => phase.id,
      ),
    ).toEqual(["investigation", "cross-review", "own-model-review", "synthesis"]);
  });

  it("surfaces own-model review status and retry affordance", () => {
    const workflow = makeWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeWorkflow().investigatorA,
        selfReviewStatus: "running",
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
      },
    });

    expect(statusLabel(workflow)).toBe("Own-model reviewing");
    expect(canRetryFailedInvestigationPhase(workflow)).toBe(false);
    expect(canRetrySelfReview(workflow)).toBe(false);
    expect(canRetrySynthesis(workflow)).toBe(false);
  });

  it("prioritizes active cross-review status over concurrent own-model review status", () => {
    const workflow = makeWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeWorkflow().investigatorA,
        crossReviewStatus: "running",
        selfReviewStatus: "running",
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
      },
    });

    expect(statusLabel(workflow)).toBe("Cross-reviewing");
  });

  it("allows synthesis retry only after required own-model reviews complete", () => {
    const workflow = makeWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeWorkflow().investigatorA,
        selfReviewStatus: "completed",
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
      },
      investigatorB: {
        ...makeWorkflow().investigatorB,
        selfReviewStatus: "completed",
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-b"),
      },
      synthesis: {
        ...makeWorkflow().synthesis,
        status: "error",
        error: "Synthesis failed",
      },
    });

    expect(canRetrySelfReview(workflow)).toBe(true);
    expect(canRetrySynthesis(workflow)).toBe(true);
  });
});
