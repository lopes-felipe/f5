import type { PlanningWorkflow, WorkflowBranch, WorkflowModelSlot } from "@t3tools/contracts";

import {
  WORKFLOW_CODE_REVIEW_RUBRIC_SECTION,
  WORKFLOW_PLAN_DEPTH_SECTION,
  WORKFLOW_PLAN_MODE_QUESTIONS_SECTION,
  WORKFLOW_PLAN_REVIEW_RUBRIC_SECTION,
  WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
  WORKFLOW_REVIEW_DISPOSITION_SECTION,
  WORKFLOW_SEVERITY_SCALE_SECTION,
  WORKFLOW_UNATTENDED_STAGE_SECTION,
  type WorkflowRetryContext,
  workflowLensSection,
  workflowPlanOutputContractSection,
  workflowRetryContextSection,
  workflowReviewOutputContractSection,
  workflowUpstreamArtifactSection,
} from "./workflowPromptFragments.ts";
import { joinPromptSections, providerGuidanceSection, slotLabel } from "./workflowSharedUtils.ts";

export interface WorkflowPromptArtifactSource {
  readonly workflowId: string;
  readonly stage: string;
  readonly turnId?: string | undefined;
  readonly messageId?: string | undefined;
}

interface ReviewInput {
  readonly reviewerLabel: string;
  readonly reviewMarkdown: string;
  readonly source: WorkflowPromptArtifactSource;
}

export function buildAuthorPromptSections(input: {
  readonly workflow: PlanningWorkflow;
  readonly branch: WorkflowBranch;
  readonly authorSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
You are Author ${input.branch.branchId.toUpperCase()} in a dual-model planning workflow. Produce a complete standalone implementation plan. Another author works independently and a later model merges both plans.`,
    workflowLensSection({ stage: "author", branch: input.branch.branchId }),
    `## Authoritative Requirement
${input.workflow.requirementPrompt}`,
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.authorSlot.provider),
    WORKFLOW_PLAN_DEPTH_SECTION,
    `## Planning Method
- Explore the relevant codebase before you write the plan. Read the current implementation, trace affected flows, and ground decisions in code you inspected.
- Keep scope tight and identify existing shared logic before proposing new helpers.
- Use \`file_path:line_number\` for verified current-code claims.
- Specify schema changes, precedence, persistence and replay behavior, failure and recovery paths, compatibility, and exact verification commands.
- Distinguish verified repository facts from assumptions and record rejected alternatives where they materially affect implementation.`,
    WORKFLOW_PLAN_MODE_QUESTIONS_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowPlanOutputContractSection({ kind: "author", provider: input.authorSlot.provider }),
  ];
}

export function buildAuthorPrompt(input: Parameters<typeof buildAuthorPromptSections>[0]): string {
  return joinPromptSections(buildAuthorPromptSections(input));
}

export function buildReviewPromptSections(input: {
  readonly requirementPrompt: string;
  readonly planMarkdown: string;
  readonly planSource: WorkflowPromptArtifactSource;
  readonly reviewKind: "cross" | "self";
  readonly lensBranch: "a" | "b";
  readonly reviewerSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  const framing =
    input.reviewKind === "self"
      ? "Audit your own earlier plan as a fresh independent reviewer. Do not defend prior decisions."
      : "Audit another model's plan independently. Do not defer to its confidence or framing.";
  return [
    `## Role
${framing}`,
    workflowLensSection({
      stage: "plan-review",
      branch: input.lensBranch,
    }),
    `## Authoritative Requirement
${input.requirementPrompt}`,
    workflowUpstreamArtifactSection({
      heading: "Plan Under Review",
      body: input.planMarkdown,
      source: input.planSource,
      escaping: "entity",
    }),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.reviewerSlot.provider),
    WORKFLOW_PLAN_REVIEW_RUBRIC_SECTION,
    WORKFLOW_SEVERITY_SCALE_SECTION,
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowReviewOutputContractSection("plan"),
  ];
}

export function buildReviewPrompt(input: Parameters<typeof buildReviewPromptSections>[0]): string {
  return joinPromptSections(buildReviewPromptSections(input));
}

export function buildRevisionPromptSections(input: {
  readonly requirementPrompt: string;
  readonly originalPlan: {
    readonly markdown: string;
    readonly source: WorkflowPromptArtifactSource;
  };
  readonly reviews: ReadonlyArray<ReviewInput>;
  readonly targetSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Revise the implementation plan after independently validating every review finding. Preserve unaffected decisions, reject unsupported scope growth, and make one coherent replacement plan.`,
    `## Authoritative Requirement
${input.requirementPrompt}`,
    workflowUpstreamArtifactSection({
      heading: "Original Plan",
      body: input.originalPlan.markdown,
      source: input.originalPlan.source,
      escaping: "envelope-only",
    }),
    ...input.reviews.map((review) =>
      workflowUpstreamArtifactSection({
        heading: review.reviewerLabel,
        body: review.reviewMarkdown,
        source: review.source,
        escaping: "entity",
      }),
    ),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    WORKFLOW_PLAN_DEPTH_SECTION,
    `## Revision Rules
- Validate findings against the requirement and live repository; do not accept feedback merely because it sounds confident.
- Fix accepted findings in the plan body. Preserve sound choices and explicitly adjudicate contradictions by evidence strength.
- Do not introduce features or refactors unrelated to a supported finding or the requirement.`,
    WORKFLOW_REVIEW_DISPOSITION_SECTION,
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowPlanOutputContractSection({ kind: "revision", provider: input.targetSlot.provider }),
  ];
}

export function buildRevisionPrompt(
  input: Parameters<typeof buildRevisionPromptSections>[0],
): string {
  return joinPromptSections(buildRevisionPromptSections(input));
}

export function buildMergePromptSections(input: {
  readonly workflow: PlanningWorkflow;
  readonly planA: { readonly markdown: string; readonly source: WorkflowPromptArtifactSource };
  readonly planB: { readonly markdown: string; readonly source: WorkflowPromptArtifactSource };
  readonly modelA: WorkflowModelSlot;
  readonly modelB: WorkflowModelSlot;
  readonly reviews?: ReadonlyArray<ReviewInput> | undefined;
  readonly mergeSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Synthesize two independently authored and reviewed plans into one decision-complete implementation plan. Integrate useful coverage from both scrutiny lenses while choosing one resolution for every genuine conflict.`,
    `## Authoritative Requirement
${input.workflow.requirementPrompt}`,
    workflowUpstreamArtifactSection({
      heading: `Plan A — ${slotLabel(input.modelA)}`,
      body: input.planA.markdown,
      source: input.planA.source,
      escaping: "envelope-only",
    }),
    workflowUpstreamArtifactSection({
      heading: `Plan B — ${slotLabel(input.modelB)}`,
      body: input.planB.markdown,
      source: input.planB.source,
      escaping: "envelope-only",
    }),
    ...(input.reviews ?? []).map((review) =>
      workflowUpstreamArtifactSection({
        heading: review.reviewerLabel,
        body: review.reviewMarkdown,
        source: review.source,
        escaping: "entity",
      }),
    ),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.mergeSlot.provider),
    WORKFLOW_PLAN_DEPTH_SECTION,
    `## Merge Rules
- Reinspect disagreements and conflicting factual claims in the repository. Do not redo settled analysis without cause.
- Resolve conflicts using requirement fit, verified repository evidence, simplicity, reliability, and compatibility, in that order.
- Do not concatenate plans, average incompatible approaches, or include meta-review prose.
- Preserve complementary coverage even when one plan supplies the chosen implementation approach.`,
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowPlanOutputContractSection({ kind: "merge", provider: input.mergeSlot.provider }),
  ];
}

export function buildMergePrompt(input: Parameters<typeof buildMergePromptSections>[0]): string {
  return joinPromptSections(buildMergePromptSections(input));
}

export function buildImplementationPromptSections(input: {
  readonly workflow: PlanningWorkflow;
  readonly mergedPlanMarkdown: string;
  readonly implementationSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Implement the approved merged plan completely in the current workspace.`,
    `## Authoritative Requirement
${input.workflow.requirementPrompt}`,
    workflowUpstreamArtifactSection({
      heading: "Approved Merged Plan",
      body: input.mergedPlanMarkdown,
      source: {
        workflowId: input.workflow.id,
        stage: "merge",
        ...(input.workflow.merge.turnId ? { turnId: input.workflow.merge.turnId } : {}),
      },
      escaping: "envelope-only",
    }),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.implementationSlot.provider),
    `## Implementation Requirements
- Read the relevant existing code before modifying it, and follow the established local conventions.
- Treat the live repository as source of truth and the merged plan as approved intent. If a plan detail is stale, make the smallest compatible adjustment and report the deviation.
- Preserve unrelated dirty work. Prefer shared abstractions over duplicate local fixes, without unrelated cleanup.
- Run every repository-required check plus focused tests. Report the actual commands and results; never claim success while a required check fails.
- Do not commit or push unless the user asks.`,
  ];
}

export function buildImplementationPrompt(
  input: Parameters<typeof buildImplementationPromptSections>[0],
): string {
  return joinPromptSections(buildImplementationPromptSections(input));
}

export interface WorkflowReviewPatchArtifact {
  readonly patchText: string;
  readonly source: WorkflowPromptArtifactSource;
  readonly fullPatchHash?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly truncationReason?: string | null | undefined;
}

export function buildCodeReviewPromptSections(input: {
  readonly mergedPlanMarkdown: string;
  readonly requirementPrompt: string;
  readonly reviewArtifact: WorkflowReviewPatchArtifact;
  readonly reviewerLabel: string;
  readonly lensBranch: "a" | "b";
  readonly reviewerSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  const truncation = input.reviewArtifact.truncated
    ? `The persisted patch is truncated (${input.reviewArtifact.truncationReason ?? "size limit"}). Do not infer that omitted files are clean.`
    : "The persisted patch is the review artifact for this implementation turn.";
  return [
    `## Role
You are ${input.reviewerLabel}. Review the persisted implementation delta; do not modify code.`,
    workflowLensSection({ stage: "code-review", branch: input.lensBranch }),
    `## Authoritative Requirement
${input.requirementPrompt}`,
    workflowUpstreamArtifactSection({
      heading: "Approved Plan",
      body: input.mergedPlanMarkdown,
      source: { workflowId: input.reviewArtifact.source.workflowId, stage: "merge" },
      escaping: "entity",
    }),
    `## Review Artifact Identity
Full patch hash: ${input.reviewArtifact.fullPatchHash ?? "unavailable"}. ${truncation}`,
    workflowUpstreamArtifactSection({
      heading: "Implementation Patch",
      body: input.reviewArtifact.patchText,
      source: input.reviewArtifact.source,
      escaping: "entity",
    }),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.reviewerSlot.provider),
    WORKFLOW_CODE_REVIEW_RUBRIC_SECTION,
    WORKFLOW_SEVERITY_SCALE_SECTION,
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowReviewOutputContractSection("implementation"),
  ];
}

export function buildCodeReviewPrompt(
  input: Parameters<typeof buildCodeReviewPromptSections>[0],
): string {
  return joinPromptSections(buildCodeReviewPromptSections(input));
}

export function buildImplementationRevisionPromptSections(input: {
  readonly requirementPrompt: string;
  readonly reviews: ReadonlyArray<ReviewInput>;
  readonly targetSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Apply validated code-review feedback to the implementation. Make code changes directly; do not merely describe them.`,
    `## Authoritative Requirement
${input.requirementPrompt}`,
    ...input.reviews.map((review) =>
      workflowUpstreamArtifactSection({
        heading: review.reviewerLabel,
        body: review.reviewMarkdown,
        source: review.source,
        escaping: "entity",
      }),
    ),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Apply-Feedback Rules
- Validate each finding against the live repository and original requirement.
- Apply accepted and partially accepted findings with the smallest compatible change; reject unsupported scope growth.
- Preserve unrelated dirty work and unaffected implementation decisions.
- Run focused tests and every repository-required check. Report actual commands and results, including failures.
- Summarize rejected feedback with concrete evidence. Do not commit or push unless asked.`,
    WORKFLOW_REVIEW_DISPOSITION_SECTION,
  ];
}

export function buildImplementationRevisionPrompt(
  input: Parameters<typeof buildImplementationRevisionPromptSections>[0],
): string {
  return joinPromptSections(buildImplementationRevisionPromptSections(input));
}
