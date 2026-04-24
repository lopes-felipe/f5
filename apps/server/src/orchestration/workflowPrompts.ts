import type {
  PlanningWorkflow,
  ProviderKind,
  WorkflowBranch,
  WorkflowModelSlot,
} from "@t3tools/contracts";

import { joinPromptSections, providerGuidanceSection, slotLabel } from "./workflowSharedUtils.ts";

export function buildAuthorPrompt(input: {
  readonly workflow: PlanningWorkflow;
  readonly branch: WorkflowBranch;
  readonly provider?: ProviderKind;
}): string {
  return joinPromptSections([
    `Please create a detailed implementation plan for the following requirement:

${input.workflow.requirementPrompt}`,
    `You are Author ${input.branch.branchId.toUpperCase()} in a multi-model planning workflow. Your plan will be independently reviewed and later merged with another plan. Focus on producing the strongest standalone plan.`,
    providerGuidanceSection(input.provider),
    `## Planning Requirements
- Explore the relevant codebase before you write the plan. Read the current implementation, trace the affected flows, and ground the plan in code you actually inspected.
- Keep the scope tight. Do not add features, speculative abstractions, or cleanup beyond what the requirement asks for.
- Make the plan decision complete: the implementer should not need to make judgment calls.
- Be concrete about affected files, symbols, data flow, edge cases, failure modes, and verification steps.
- Include specific file references. When you refer to existing code, use \`file_path:line_number\` references.`,
    `Return the full plan in your assistant response.
Do not create or modify files during this planning phase.`,
  ]);
}

export function buildReviewPrompt(input: {
  readonly planMarkdown: string;
  readonly reviewKind: "cross" | "self";
  readonly provider?: ProviderKind;
}): string {
  const reviewInstructions =
    input.reviewKind === "self"
      ? `You are reviewing your own previously authored plan, but this must be treated as a fresh independent audit.
Do not restate or defend the plan. Critically inspect it for weaknesses, omissions, contradictions, risky assumptions,
and places where the implementation could fail or become harder to maintain.`
      : `You are reviewing another model's implementation plan. Provide an independent critique and focus on where the
plan is incomplete, risky, or technically weaker than it should be.`;

  return joinPromptSections([
    "Please review the following implementation plan.",
    `## Plan

${input.planMarkdown}`,
    reviewInstructions,
    providerGuidanceSection(input.provider),
    `## Review Requirements
- Produce findings first. Do not restate, rewrite, or defend the plan.
- Check correctness, completeness, edge cases, failure modes, and verification gaps.
- Run a code reuse review: search for existing utilities, shared modules, and adjacent patterns before endorsing new helpers or duplicate logic.
- Run a code quality review: look for redundant state, parameter sprawl, copy-paste, stringly-typed interfaces, and leaky abstractions.
- Run an efficiency review: look for unnecessary work, missed concurrency, hot-path bloat, repeated I/O, and memory or cleanup risks.
- Call out places where the plan adds scope or complexity beyond the user's request.
- When you reference the current codebase, use \`file_path:line_number\` references.`,
    "Structure your review as actionable findings that the author can apply. Do not rewrite the plan.",
  ]);
}

export function buildRevisionPrompt(input: {
  readonly reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewMarkdown: string;
  }>;
}): string {
  const reviewSections = input.reviews.map(
    (review) => `## ${review.reviewerLabel}\n\n${review.reviewMarkdown}`,
  );

  return `Reviewers have provided feedback on your plan. Their reviews are:

${reviewSections.join("\n\n")}

Please:
1. Read all reviews carefully.
2. Consider each piece of feedback.
3. Apply the comments you agree with.
4. Produce an updated plan that incorporates the accepted changes.

The revised plan should be a complete replacement, not a diff.
Return the full revised plan in your assistant response.
Do not create or modify files during this planning phase.`;
}

export function buildMergePrompt(input: {
  readonly workflow: PlanningWorkflow;
  readonly planAMarkdown: string;
  readonly planBMarkdown: string;
  readonly modelA: WorkflowModelSlot;
  readonly modelB: WorkflowModelSlot;
}): string {
  return `You have two independently authored and reviewed implementation plans for the same requirement.
Please merge them into a single comprehensive plan.

## Original Requirement

${input.workflow.requirementPrompt}

## Plan A (by ${slotLabel(input.modelA)})
${input.planAMarkdown}

## Plan B (by ${slotLabel(input.modelB)})
${input.planBMarkdown}

Read both plans and produce a merged plan that:
- Takes the strongest ideas from each
- Resolves contradictions by choosing the better approach
- Maintains a coherent structure
- Does not simply concatenate; truly synthesize the plans

Return the merged plan in your assistant response.
Do not create or modify files during this planning phase.`;
}

export function buildImplementationPrompt(input: {
  readonly workflow: PlanningWorkflow;
  readonly mergedPlanMarkdown: string;
  readonly provider?: ProviderKind;
}): string {
  return joinPromptSections([
    "Please implement the following plan. The plan was produced by a multi-model planning workflow and has been reviewed, revised, and merged. Implement it thoroughly.",
    `## Original Requirement

${input.workflow.requirementPrompt}`,
    `## Merged Plan

${input.mergedPlanMarkdown}`,
    providerGuidanceSection(input.provider),
    `## Implementation Requirements
- Read the relevant existing code before modifying it, and follow the established local conventions.
- Prefer simple, direct changes over clever abstractions or speculative refactors.
- Keep the implementation scoped to the approved plan and the requested behavior. Do not add extra features or unrelated cleanup.
- Verify before you claim the work is done: run the most relevant tests or checks, inspect the output, and report the real result.`,
    "Implement this plan completely. Follow the plan closely, create any necessary files, and make the described changes directly in the codebase.",
  ]);
}

export function buildCodeReviewPrompt(input: {
  readonly mergedPlanMarkdown: string;
  readonly requirementPrompt: string;
  readonly reviewerLabel: string;
  readonly provider?: ProviderKind;
}): string {
  return joinPromptSections([
    "You are performing a code review of an implementation that was produced from a merged plan.",
    `## Original Requirement

${input.requirementPrompt}`,
    `## Plan That Was Implemented

${input.mergedPlanMarkdown}`,
    "## Your Task\n\nReview the code changes made in the workspace. Use `git diff` and targeted file inspection to understand what was implemented. Compare the implementation against the plan and the original requirement.",
    providerGuidanceSection(input.provider),
    `## Review Requirements
- Structure the report as findings first, ordered by severity.
- Use \`file_path:line_number\` for every code-specific finding.
- Check whether the implementation correctly and completely follows the plan and the original requirement.
- Assess blast radius for material issues: note whether a problem is local and reversible or broad, stateful, or hard to unwind.
- Review security with OWASP Top 10 awareness, including injection, access control, auth/session handling, unsafe path or file handling, SSRF, XSS, and sensitive-data exposure.
- Flag extra features, speculative cleanup, or scope expansion that the user did not ask for.
- Call out missing tests, reliability problems, failure-mode gaps, and concrete maintainability or performance issues.`,
    `You are reviewer: ${input.reviewerLabel}

Provide clear, constructive feedback that the implementing model can act on.
Do NOT rewrite the implementation; provide review comments only.`,
  ]);
}

export function buildImplementationRevisionPrompt(input: {
  readonly reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewMarkdown: string;
  }>;
}): string {
  const reviewSections = input.reviews.map(
    (review) => `## ${review.reviewerLabel}\n\n${review.reviewMarkdown}`,
  );

  return `Code reviewers have provided feedback on your implementation. Their reviews are:

${reviewSections.join("\n\n")}

Please:
1. Read all reviews carefully.
2. Consider each piece of feedback.
3. Apply the changes you agree with to the codebase.
4. For any feedback you disagree with, briefly explain why.

Make the code changes directly: edit the files, do not just describe what you would change.`;
}
