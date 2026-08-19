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
  it("keeps author sections stable and applies provider-aware capture", () => {
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
      "## Role",
      "## Scrutiny Lens A",
      "## Authoritative Requirement",
      "## Provider-Specific Guidance",
      "## Requested Detail Level",
      "## Planning Method",
      "## Clarifying Questions",
      "## Read-Only Constraint",
      "## Plan Output Contract",
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
    expect(codex).toContain("<proposed_plan>");
    expect(codex).not.toContain("ExitPlanMode");
    expect(claude).toContain("ExitPlanMode");
    expect(claude).not.toContain("<proposed_plan>");
    expect(codex).not.toContain("Please:");
  });

  it("builds unattended evidence-first plan reviews with requirement propagation", () => {
    const sections = buildReviewPromptSections({
      requirementPrompt: "Implement the feature",
      planMarkdown: "# Plan\n## Embedded heading",
      planSource: SOURCE,
      reviewKind: "cross",
      lensBranch: "b",
      reviewerSlot: CLAUDE_SLOT,
    });
    expect(headings(sections)).toEqual([
      "## Role",
      "## Scrutiny Lens B",
      "## Authoritative Requirement",
      "## Plan Under Review",
      "## Provider-Specific Guidance",
      "## Plan Review Rubric",
      "## Severity Scale",
      "## Unattended Stage",
      "## Read-Only Constraint",
      "## Review Output Contract",
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
    expect(text).not.toContain("## Clarifying Questions");
    expect(text).not.toContain("Read all reviews carefully");
  });

  it("requires evidence-backed review dispositions in replacement revisions", () => {
    const text = buildRevisionPrompt({
      requirementPrompt: "Implement the feature",
      originalPlan: { markdown: "# Plan", source: SOURCE },
      reviews: [{ reviewerLabel: "Cross review", reviewMarkdown: "Finding", source: SOURCE }],
      targetSlot: CODEX_SLOT,
    });
    expect(text).toContain("## Review Disposition");
    expect(text).toContain("A blocker may never be deferred");
    expect(text).toContain("complete replacement");
  });

  it("merges without concatenating incompatible approaches", () => {
    const workflow = makeWorkflow();
    const text = buildMergePrompt({
      workflow,
      planA: { markdown: "# Plan A", source: SOURCE },
      planB: { markdown: "# Plan B", source: { ...SOURCE, stage: "author-b" } },
      modelA: CODEX_SLOT,
      modelB: CLAUDE_SLOT,
      mergeSlot: CODEX_SLOT,
    });
    expect(text).toContain("Do not concatenate plans");
    expect(text).toContain("one resolution for every genuine conflict");
    expect(text).toContain("<proposed_plan>");
  });

  it("keeps implementation grounded in repository checks", () => {
    const text = buildImplementationPrompt({
      workflow: makeWorkflow(),
      mergedPlanMarkdown: "# Plan\nUse `Array<Foo>`.",
      implementationSlot: CODEX_SLOT,
    });
    expect(text).toContain("Read the relevant existing code before modifying it");
    expect(text).toContain("actual commands and results");
    expect(text).toContain("Do not commit or push unless the user asks");
    expect(text).toContain("Array<Foo>");
  });

  it("reviews persisted implementation artifacts with a closed output contract", () => {
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
    expect(text).not.toContain("## Clarifying Questions");
  });
});
