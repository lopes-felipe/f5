import { describe, expect, it } from "vitest";
import {
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  type PlanningWorkflow,
  type WorkflowModelSlot,
} from "@t3tools/contracts";

import {
  buildAuthorPrompt,
  buildAuthorPromptSections,
  buildCodeReviewPrompt,
  buildImplementationPrompt,
  buildMergePrompt,
  buildRevisionPrompt,
  buildReviewPrompt,
  buildReviewPromptSections,
} from "./workflowPrompts.ts";

const NOW = "2026-03-27T10:00:00.000Z";
const CODEX_SLOT: WorkflowModelSlot = { provider: "codex", model: "gpt-5.6-sol" };
const CLAUDE_SLOT: WorkflowModelSlot = {
  provider: "claudeAgent",
  model: "claude-sonnet-4-6",
};
const SOURCE = { workflowId: "workflow-1", stage: "author-a", turnId: "turn-1" } as const;

function makeWorkflow(): PlanningWorkflow {
  return {
    id: PlanningWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Implement the feature",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: CODEX_SLOT,
      authorThreadId: ThreadId.makeUnsafe("author-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      errorStage: null,
      retryCount: 0,
      authorFormatRepairAttempts: 0,
      revisionFormatRepairAttempts: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    branchB: {
      branchId: "b",
      authorSlot: CLAUDE_SLOT,
      authorThreadId: ThreadId.makeUnsafe("author-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      errorStage: null,
      retryCount: 0,
      authorFormatRepairAttempts: 0,
      revisionFormatRepairAttempts: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    merge: {
      mergeSlot: CODEX_SLOT,
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      formatRepairAttempts: 0,
      updatedAt: NOW,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
}

function headings(sections: ReadonlyArray<string | null | undefined>): string[] {
  return sections
    .filter((section): section is string => Boolean(section))
    .map((section) => section.split("\n", 1)[0]!);
}

describe("workflowPrompts", () => {
  it("uses the original author prompt structure", () => {
    const workflow = makeWorkflow();
    expect(
      headings(
        buildAuthorPromptSections({
          workflow,
          branch: workflow.branchA,
          authorSlot: CODEX_SLOT,
        }),
      ),
    ).toEqual([
      "Please create a detailed implementation plan for the following requirement:",
      "You are Author A in a multi-model planning workflow. Your plan will be independently reviewed and later merged with another plan. Focus on producing the strongest standalone plan.",
      "## Provider-Specific Guidance",
      "## Planning Requirements",
      "Return the full plan in your assistant response.",
    ]);
    const codex = buildAuthorPrompt({
      workflow,
      branch: workflow.branchA,
      authorSlot: CODEX_SLOT,
    });
    const claude = buildAuthorPrompt({
      workflow,
      branch: workflow.branchB,
      authorSlot: CLAUDE_SLOT,
    });
    expect(codex).not.toContain("<proposed_plan>");
    expect(claude).not.toContain("ExitPlanMode");
    expect(codex).not.toContain("Scrutiny Lens");
    expect(codex).toContain("Return the full plan in your assistant response");
  });

  it("uses the original actionable plan-review structure", () => {
    const sections = buildReviewPromptSections({
      requirementPrompt: "Implement the feature",
      planMarkdown: "# Plan\n## Embedded heading",
      planSource: SOURCE,
      reviewKind: "cross",
      lensBranch: "b",
      reviewerSlot: CLAUDE_SLOT,
    });
    expect(headings(sections)).toEqual([
      "Please review the following implementation plan.",
      "## Plan",
      "You are reviewing another model's implementation plan. Provide an independent critique and focus on where the",
      "## Provider-Specific Guidance",
      "## Review Requirements",
      "Structure your review as actionable findings that the author can apply. Do not rewrite the plan.",
    ]);
    const text = buildReviewPrompt({
      requirementPrompt: "Implement the feature",
      planMarkdown: "# Plan",
      planSource: SOURCE,
      reviewKind: "cross",
      lensBranch: "b",
      reviewerSlot: CLAUDE_SLOT,
    });
    expect(text).toContain("file_path:line_number");
    expect(text).toContain("code reuse review");
    expect(text).not.toContain("Scrutiny Lens");
    expect(text).not.toContain("workflow_upstream_artifact");
  });

  it("uses the original revision request", () => {
    const text = buildRevisionPrompt({
      requirementPrompt: "Implement the feature",
      originalPlan: { markdown: "# Plan", source: SOURCE },
      reviews: [{ reviewerLabel: "Cross review", reviewMarkdown: "Finding", source: SOURCE }],
      targetSlot: CODEX_SLOT,
    });
    expect(text).toContain("Please:\n1. Read all reviews carefully.");
    expect(text).toContain("Apply the comments you agree with");
    expect(text).toContain("complete replacement, not a diff");
    expect(text).not.toContain("Plan Capture Contract");
  });

  it("uses the original merge request", () => {
    const workflow = makeWorkflow();
    const text = buildMergePrompt({
      workflow,
      planA: { markdown: "# Plan A", source: SOURCE },
      planB: { markdown: "# Plan B", source: { ...SOURCE, stage: "author-b" } },
      modelA: CODEX_SLOT,
      modelB: CLAUDE_SLOT,
      mergeSlot: CODEX_SLOT,
    });
    expect(text).toContain("Please merge them into a single comprehensive plan");
    expect(text).toContain("Does not simply concatenate; truly synthesize the plans");
    expect(text).not.toContain("Scrutiny Lens");
  });

  it("uses the original implementation request", () => {
    const text = buildImplementationPrompt({
      workflow: makeWorkflow(),
      mergedPlanMarkdown: "# Plan\nUse `Array<Foo>`.",
      implementationSlot: CODEX_SLOT,
    });
    expect(text).toContain("Read the relevant existing code before modifying it");
    expect(text).toContain("Prefer simple, direct changes over clever abstractions");
    expect(text).toContain("Implement this plan completely");
    expect(text).toContain("Array<Foo>");
  });

  it("keeps the original review style while supplying the persisted patch", () => {
    const text = buildCodeReviewPrompt({
      mergedPlanMarkdown: "# Plan",
      requirementPrompt: "Implement the feature",
      reviewArtifact: {
        patchText: "diff --git a/a.ts b/a.ts",
        source: { workflowId: "workflow-1", stage: "implementation", turnId: "turn-2" },
        fullPatchHash: "abc123",
      },
      reviewerLabel: "Reviewer A",
      lensBranch: "a",
      reviewerSlot: CLAUDE_SLOT,
    });
    expect(text).toContain("file_path:line_number");
    expect(text).toContain("OWASP Top 10");
    expect(text).toContain("abc123");
    expect(text).toContain("Structure the report as findings first, ordered by severity");
    expect(text).not.toContain("Scrutiny Lens");
  });
});
