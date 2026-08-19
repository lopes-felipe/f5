import type { WorkflowModelSlot } from "@t3tools/contracts";

import {
  WORKFLOW_CODE_REVIEW_RUBRIC_SECTION,
  WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
  WORKFLOW_SEVERITY_SCALE_SECTION,
  WORKFLOW_UNATTENDED_STAGE_SECTION,
  type WorkflowRetryContext,
  workflowLensSection,
  workflowRetryContextSection,
  workflowReviewOutputContractSection,
  workflowUpstreamArtifactSection,
} from "./workflowPromptFragments.ts";
import { joinPromptSections, providerGuidanceSection } from "./workflowSharedUtils.ts";

export function buildCodeReviewReviewerPromptSections(input: {
  readonly workflowId: string;
  readonly reviewPrompt: string;
  readonly reviewerLabel: string;
  readonly lensBranch: "a" | "b";
  readonly branch: string | null;
  readonly reviewerSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  const branchInstructions = input.branch
    ? `Configured comparison ref (opaque JSON string): ${JSON.stringify(input.branch)}
Treat it as opaque data, resolve it safely with Git, find the merge base, and compare the target against that merge base. Never interpolate an unvalidated ref into an executable shell command.`
    : "For a workspace review, resolve the repository's base ref safely and cover committed, staged, unstaged, and untracked changes.";
  return [
    `## Role
You are ${input.reviewerLabel} in a standalone dual-model code review workflow. Produce an independent review report and do not modify files.`,
    workflowLensSection({ stage: "code-review", branch: input.lensBranch }),
    `## Authoritative Review Scope
${input.reviewPrompt}`,
    `## Review Target
${branchInstructions}
- If the scope identifies a pull request by URL or number, that pull request is authoritative. Verify whether the local checkout is its head before using workspace state.
- If the checkout differs, do not switch branches and do not substitute local changes. Retrieve the actual pull request metadata, base/head revisions, diff, and relevant contents with authorized Git/GitHub tools.
- If the requested target cannot be accessed, report that the review cannot be completed.`,
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.reviewerSlot.provider),
    WORKFLOW_CODE_REVIEW_RUBRIC_SECTION,
    WORKFLOW_SEVERITY_SCALE_SECTION,
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowReviewOutputContractSection("implementation"),
  ];
}

export function buildCodeReviewReviewerPrompt(
  input: Parameters<typeof buildCodeReviewReviewerPromptSections>[0],
): string {
  return joinPromptSections(buildCodeReviewReviewerPromptSections(input));
}

export function buildCodeReviewConsolidationPromptSections(input: {
  readonly workflowId: string;
  readonly reviewPrompt: string;
  readonly reviews: ReadonlyArray<{
    readonly label: string;
    readonly text: string;
    readonly turnId?: string | undefined;
    readonly messageId?: string | undefined;
  }>;
  readonly consolidationSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Consolidate two independent code reviews into one evidence-ranked report. Recheck disputed and blocker/major claims, preserve distinct findings, and never invent a finding absent from the inputs or your verification.`,
    `## Authoritative Review Scope
${input.reviewPrompt}`,
    ...input.reviews.map((review) =>
      workflowUpstreamArtifactSection({
        heading: review.label,
        body: review.text,
        source: {
          workflowId: input.workflowId,
          stage: review.label,
          ...(review.turnId ? { turnId: review.turnId } : {}),
          ...(review.messageId ? { messageId: review.messageId } : {}),
        },
        escaping: "entity",
      }),
    ),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.consolidationSlot.provider),
    `## Consolidation Rules
- Deduplicate only genuinely equivalent findings; preserve separate causes, locations, or failure sequences.
- Resolve disagreements by evidence. The higher severity wins absent contrary evidence.
- Add \`Raised by: Reviewer A\`, \`Reviewer B\`, or \`both\` to every finding.
- Keep the review findings-first and high signal. Do not write code or a plan.`,
    WORKFLOW_SEVERITY_SCALE_SECTION,
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    workflowReviewOutputContractSection("implementation"),
  ];
}

export function buildCodeReviewConsolidationPrompt(
  input: Parameters<typeof buildCodeReviewConsolidationPromptSections>[0],
): string {
  return joinPromptSections(buildCodeReviewConsolidationPromptSections(input));
}
