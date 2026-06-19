import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "./baseSchemas";
import { InvestigationWorkflow, InvestigationWorkflowId } from "./investigationWorkflow";

const NOW = "2026-04-12T12:00:00.000Z";

function makeLegacyWorkflowRecord() {
  return {
    id: InvestigationWorkflowId.makeUnsafe("investigation-workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Investigation workflow",
    slug: "investigation-workflow",
    problemPrompt: "Investigate the issue",
    branch: null,
    investigatorA: {
      label: "Investigator A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      investigationThreadId: ThreadId.makeUnsafe("investigator-a"),
      investigationStatus: "completed",
      investigationTurnId: "turn-investigation-a",
      investigationMessageId: "message-investigation-a",
      crossReviewThreadId: null,
      crossReviewStatus: "not_started",
      crossReviewTurnId: null,
      crossReviewMessageId: null,
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
      crossReviewThreadId: null,
      crossReviewStatus: "not_started",
      crossReviewTurnId: null,
      crossReviewMessageId: null,
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
  };
}

describe("InvestigationWorkflow", () => {
  it("defaults own-model review fields when decoding legacy records", () => {
    const workflow = Schema.decodeUnknownSync(InvestigationWorkflow)(makeLegacyWorkflowRecord());

    expect(workflow.selfReviewEnabled).toBe(false);
    expect(workflow.investigatorA.selfReviewThreadId).toBeNull();
    expect(workflow.investigatorA.selfReviewStatus).toBe("not_started");
    expect(workflow.investigatorA.selfReviewTurnId).toBeNull();
    expect(workflow.investigatorA.selfReviewMessageId).toBeNull();
    expect(workflow.investigatorB.selfReviewThreadId).toBeNull();
    expect(workflow.investigatorB.selfReviewStatus).toBe("not_started");
    expect(workflow.investigatorB.selfReviewTurnId).toBeNull();
    expect(workflow.investigatorB.selfReviewMessageId).toBeNull();
  });
});
