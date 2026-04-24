import { describe, expect, it } from "vitest";
import { PlanningWorkflowId, ProjectId, ThreadId, type PlanningWorkflow } from "@t3tools/contracts";

import {
  buildAuthorPrompt,
  buildCodeReviewPrompt,
  buildImplementationPrompt,
  buildMergePrompt,
  buildRevisionPrompt,
  buildReviewPrompt,
} from "./workflowPrompts.ts";

const NOW = "2026-03-27T10:00:00.000Z";

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
      updatedAt: NOW,
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
      updatedAt: NOW,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
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

describe("workflowPrompts", () => {
  it("keeps authoring prompts chat-first", () => {
    const workflow = makeWorkflow();
    const text = buildAuthorPrompt({
      workflow,
      branch: workflow.branchA,
    });

    expect(text).toContain("Return the full plan in your assistant response.");
    expect(text).toContain("Do not create or modify files during this planning phase.");
  });

  it("adds concrete planning guidance and claude-specific tooling notes when requested", () => {
    const workflow = makeWorkflow();
    const text = buildAuthorPrompt({
      workflow,
      branch: workflow.branchB,
      provider: "claudeAgent",
    });

    expect(text).toContain("Explore the relevant codebase before you write the plan.");
    expect(text).toContain("Make the plan decision complete");
    expect(text).toContain("file_path:line_number");
    expect(text).toContain("Prefer dedicated tools over shell commands");
  });

  it("keeps review prompts generic when no provider is specified", () => {
    const text = buildReviewPrompt({
      planMarkdown: "# Plan",
      reviewKind: "cross",
    });

    expect(text).toContain("code reuse review");
    expect(text).toContain("code quality review");
    expect(text).toContain("efficiency review");
    expect(text).not.toContain("Prefer dedicated tools over shell commands");
    expect(text).not.toContain("prefer `rg` and `rg --files`");
  });

  it("adds implementation verification and codex-specific guidance", () => {
    const text = buildImplementationPrompt({
      workflow: makeWorkflow(),
      mergedPlanMarkdown: "# Plan",
      provider: "codex",
    });

    expect(text).toContain("Read the relevant existing code before modifying it");
    expect(text).toContain("Verify before you claim the work is done");
    expect(text).toContain("prefer `rg` and `rg --files`");
  });

  it("strengthens code review prompts with blast radius and security guidance", () => {
    const text = buildCodeReviewPrompt({
      mergedPlanMarkdown: "# Plan",
      requirementPrompt: "Implement the feature",
      reviewerLabel: "Reviewer A",
      provider: "claudeAgent",
    });

    expect(text).toContain("file_path:line_number");
    expect(text).toContain("Assess blast radius");
    expect(text).toContain("OWASP Top 10");
    expect(text).toContain("extra features");
    expect(text).toContain("Prefer dedicated tools over shell commands");
  });

  it("keeps revision prompts chat-first", () => {
    const text = buildRevisionPrompt({
      reviews: [{ reviewerLabel: "cross review", reviewMarkdown: "Needs more detail." }],
    });

    expect(text).toContain("Return the full revised plan in your assistant response.");
    expect(text).toContain("Do not create or modify files during this planning phase.");
  });

  it("does not instruct merge to rely on plan files", () => {
    const workflow = makeWorkflow();
    const text = buildMergePrompt({
      workflow,
      planAMarkdown: "# Plan A",
      planBMarkdown: "# Plan B",
      modelA: workflow.branchA.authorSlot,
      modelB: workflow.branchB.authorSlot,
    });

    expect(text).toContain("Read both plans and produce a merged plan");
    expect(text).not.toContain("Read both plan files");
    expect(text).toContain("Return the merged plan in your assistant response.");
  });
});
