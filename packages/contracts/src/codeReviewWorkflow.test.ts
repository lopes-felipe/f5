import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { CodeReviewWorkflow, CodeReviewWorkflowId } from "./codeReviewWorkflow";
import { ProjectId, ThreadId } from "./baseSchemas";

function makeWorkflowRecord(now: string) {
  return {
    id: CodeReviewWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Code review workflow",
    slug: "code-review-workflow",
    reviewPrompt: "Review the branch",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: now,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-5",
      },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: now,
    },
    consolidation: {
      slot: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  };
}

describe("codeReviewWorkflow contracts", () => {
  it("decodes a workflow snapshot record", () => {
    const now = new Date().toISOString();
    const workflow = Schema.decodeUnknownSync(CodeReviewWorkflow)(makeWorkflowRecord(now));

    expect(workflow.id).toBe("workflow-1");
    expect(workflow.reviewerA.slot.provider).toBe("codex");
    expect(workflow.consolidation.status).toBe("not_started");
    expect(workflow.archivedAt).toBeNull();
  });

  it("defaults archivedAt to null when omitted for older records", () => {
    const now = new Date().toISOString();
    const record = makeWorkflowRecord(now);
    const { archivedAt: _, ...legacyRecord } = record;

    const workflow = Schema.decodeUnknownSync(CodeReviewWorkflow)(legacyRecord);

    expect(workflow.archivedAt).toBeNull();
  });
});
