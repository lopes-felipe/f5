import type { WorkflowModelSlot } from "@t3tools/contracts";

import {
  WORKFLOW_INVESTIGATION_ARTIFACT_CHAR_LIMIT,
  WORKFLOW_PLAN_MODE_QUESTIONS_SECTION,
  WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
  WORKFLOW_UNATTENDED_STAGE_SECTION,
  type WorkflowRetryContext,
  workflowEvidenceRulesSection,
  workflowLensSection,
  workflowRetryContextSection,
  workflowUpstreamArtifactSection,
} from "./workflowPromptFragments.ts";
import { joinPromptSections, providerGuidanceSection } from "./workflowSharedUtils.ts";

export function buildInvestigationPromptSections(input: {
  readonly workflowId: string;
  readonly problemPrompt: string;
  readonly investigatorLabel: string;
  readonly lensBranch: "a" | "b";
  readonly branch: string | null;
  readonly attended: boolean;
  readonly targetSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  const branchInstructions = input.branch
    ? `## Regression Baseline
The configured comparison ref is ${JSON.stringify(input.branch)}. Treat this quoted value as opaque data, resolve it safely with Git, compare its merge base with HEAD, and do not assume the cause lives in that diff.`
    : null;
  return [
    `## Role
You are ${input.investigatorLabel} in a dual-model root-cause investigation. Another model investigates independently. Divergent evidence-backed reasoning is the point; do not coordinate.`,
    workflowLensSection({ stage: "investigation", branch: input.lensBranch }),
    `## Authoritative Problem
${input.problemPrompt}`,
    branchInstructions,
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Investigation Method
- Build an explicit hypothesis tree. Prioritize by prior probability and the cheapest evidence that could confirm or rule out each branch.
- Pursue only authorized read-only tools whose result could change the conclusion. Abandon ruled-out branches and state why.
- Establish a timeline across deploys, configuration, data, dependencies, traffic, and symptom onset.
- Trace the actual code and data flow from trigger to symptom, citing \`file_path:line_number\`.
- Separate proximate trigger from underlying cause. Reproduce or simulate with read-only diagnostics where possible.
- Permit unresolved hypotheses; do not convert missing evidence into evidence of absence.`,
    workflowEvidenceRulesSection({
      subjects: "the problem, hypotheses, ruled-out branches, and conclusions",
      forbidUnverifiedCause: true,
    }),
    input.attended ? WORKFLOW_PLAN_MODE_QUESTIONS_SECTION : null,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    `## Output Contract
Return Markdown with the concise RCA core first so bounded downstream artifacts retain it:

1. \`## Summary\` — most likely cause and confidence from 0–100%.
2. \`## Primary Root Cause\` — mechanism, linked evidence chain, fact/inference labels, and what raises confidence to 100%.
3. \`## Alternative Hypotheses\` — confidence and evidence for/against each.
4. \`## Ruled Out\` — bounded evidence that eliminated each branch.
5. \`## Proposed Solution\` — describe only; \`None\` or \`needs more data\` is valid.
6. \`## Open Questions And Unknowns\`.`,
  ];
}

export function buildInvestigationPrompt(
  input: Parameters<typeof buildInvestigationPromptSections>[0],
): string {
  return joinPromptSections(buildInvestigationPromptSections(input));
}

export function buildInvestigationCrossReviewPromptSections(input: {
  readonly workflowId: string;
  readonly problemPrompt: string;
  readonly peerLabel: string;
  readonly peerReport: string;
  readonly peerTurnId?: string | undefined;
  readonly peerMessageId?: string | undefined;
  readonly targetSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Adversarially validate ${input.peerLabel}'s investigation on a fresh stage. Default to skepticism: find unsupported, refuted, incomplete, or overconfident claims rather than looking for agreement.`,
    `## Authoritative Problem
${input.problemPrompt}`,
    workflowUpstreamArtifactSection({
      heading: "Peer Investigation To Validate",
      body: input.peerReport,
      source: {
        workflowId: input.workflowId,
        stage: input.peerLabel,
        ...(input.peerTurnId ? { turnId: input.peerTurnId } : {}),
        ...(input.peerMessageId ? { messageId: input.peerMessageId } : {}),
      },
      escaping: "entity",
      truncateToChars: WORKFLOW_INVESTIGATION_ARTIFACT_CHAR_LIMIT,
    }),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Validation Method
- Independently recheck each major finding and classify it Confirmed, Unsupported, Refuted, or Needs more evidence.
- Audit every link, query, command, and file reference for existence and whether it proves the stated claim.
- Surface missed alternatives, reasoning leaps, hidden assumptions, and revised confidence.
- Produce an adversarial validation report, not a duplicate RCA.`,
    workflowEvidenceRulesSection({ subjects: "the peer report and your validation" }),
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    `## Output Contract
1. \`## Verdicts\` — one evidence-backed verdict per major peer finding.
2. \`## Evidence Audit\` — each link/query/command and whether it supports the claim.
3. \`## Missed Hypotheses\` — alternatives with evidence for/against.
4. \`## Adjusted Certainties\` — primary and alternatives with reasoning.`,
  ];
}

export function buildInvestigationCrossReviewPrompt(
  input: Parameters<typeof buildInvestigationCrossReviewPromptSections>[0],
): string {
  return joinPromptSections(buildInvestigationCrossReviewPromptSections(input));
}

export function buildInvestigationSelfReviewPromptSections(input: {
  readonly workflowId: string;
  readonly problemPrompt: string;
  readonly investigatorLabel: string;
  readonly investigationReport: string;
  readonly investigationTurnId?: string | undefined;
  readonly investigationMessageId?: string | undefined;
  readonly targetSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  return [
    `## Role
Adversarially validate your own earlier investigation as ${input.investigatorLabel}. Do not defend it; find where it is unsupported, overconfident, incomplete, or wrong.`,
    `## Authoritative Problem
${input.problemPrompt}`,
    workflowUpstreamArtifactSection({
      heading: "Investigation To Audit",
      body: input.investigationReport,
      source: {
        workflowId: input.workflowId,
        stage: input.investigatorLabel,
        ...(input.investigationTurnId ? { turnId: input.investigationTurnId } : {}),
        ...(input.investigationMessageId ? { messageId: input.investigationMessageId } : {}),
      },
      escaping: "entity",
      truncateToChars: WORKFLOW_INVESTIGATION_ARTIFACT_CHAR_LIMIT,
    }),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Validation Method
- Recheck every major claim and evidence item; classify each as Confirmed, Unsupported, Refuted, or Needs more evidence.
- Identify reasoning leaps, hidden assumptions, overconfidence, and missed hypotheses.
- Revise certainty from evidence, not prior wording. Produce an audit, not a duplicate RCA.`,
    workflowEvidenceRulesSection({ subjects: "the original report and your audit" }),
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    `## Output Contract
1. \`## Verdicts\` — one evidence-backed verdict per original finding.
2. \`## Evidence Audit\`.
3. \`## Overconfidence Audit\`.
4. \`## Missed Hypotheses\`.
5. \`## Adjusted Certainties\`.`,
  ];
}

export function buildInvestigationSelfReviewPrompt(
  input: Parameters<typeof buildInvestigationSelfReviewPromptSections>[0],
): string {
  return joinPromptSections(buildInvestigationSelfReviewPromptSections(input));
}

export function buildInvestigationSynthesisPromptSections(input: {
  readonly workflowId: string;
  readonly problemPrompt: string;
  readonly targetSlot: WorkflowModelSlot;
  readonly retry?: WorkflowRetryContext | undefined;
  readonly contributions: ReadonlyArray<{
    readonly label: string;
    readonly investigation: string;
    readonly investigationTurnId?: string | undefined;
    readonly investigationMessageId?: string | undefined;
    readonly crossReviewOfThis: string;
    readonly crossReviewTurnId?: string | undefined;
    readonly crossReviewMessageId?: string | undefined;
    readonly selfReview?: string | null | undefined;
    readonly selfReviewTurnId?: string | undefined;
    readonly selfReviewMessageId?: string | undefined;
  }>;
}): ReadonlyArray<string | null | undefined> {
  const artifactCount = input.contributions.reduce(
    (count, contribution) => count + 2 + (contribution.selfReview ? 1 : 0),
    0,
  );
  const perArtifactLimit = Math.min(
    WORKFLOW_INVESTIGATION_ARTIFACT_CHAR_LIMIT,
    Math.floor(80_000 / Math.max(1, artifactCount)),
  );
  return [
    `## Role
Produce the final Root Cause Analysis by weighing each investigation against its peer and self reviews. Trust claims that survived adversarial validation with strong evidence; resolve disagreements by evidence, not confident tone. Synthesize rather than concatenate.`,
    `## Authoritative Problem
${input.problemPrompt}`,
    ...input.contributions.flatMap((contribution) => [
      workflowUpstreamArtifactSection({
        heading: `${contribution.label} Investigation`,
        body: contribution.investigation,
        source: {
          workflowId: input.workflowId,
          stage: `${contribution.label} investigation`,
          ...(contribution.investigationTurnId ? { turnId: contribution.investigationTurnId } : {}),
          ...(contribution.investigationMessageId
            ? { messageId: contribution.investigationMessageId }
            : {}),
        },
        escaping: "entity",
        truncateToChars: perArtifactLimit,
      }),
      workflowUpstreamArtifactSection({
        heading: `${contribution.label} Peer Cross-Review`,
        body: contribution.crossReviewOfThis,
        source: {
          workflowId: input.workflowId,
          stage: `${contribution.label} cross-review`,
          ...(contribution.crossReviewTurnId ? { turnId: contribution.crossReviewTurnId } : {}),
          ...(contribution.crossReviewMessageId
            ? { messageId: contribution.crossReviewMessageId }
            : {}),
        },
        escaping: "entity",
        truncateToChars: perArtifactLimit,
      }),
      contribution.selfReview
        ? workflowUpstreamArtifactSection({
            heading: `${contribution.label} Self-Review`,
            body: contribution.selfReview,
            source: {
              workflowId: input.workflowId,
              stage: `${contribution.label} self-review`,
              ...(contribution.selfReviewTurnId ? { turnId: contribution.selfReviewTurnId } : {}),
              ...(contribution.selfReviewMessageId
                ? { messageId: contribution.selfReviewMessageId }
                : {}),
            },
            escaping: "entity",
            truncateToChars: perArtifactLimit,
          })
        : null,
    ]),
    workflowRetryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Synthesis Rules
- Give one primary root cause with certainty from 0–100% and a verified evidence chain.
- If below 100%, list alternatives with independent certainty and explain what evidence closes the gap.
- Preserve unknowns and unresolved hypotheses. Do not manufacture consensus or evidence.`,
    workflowEvidenceRulesSection({
      subjects: "the final cause, alternatives, and proposed verification",
      forbidUnverifiedCause: true,
    }),
    WORKFLOW_UNATTENDED_STAGE_SECTION,
    WORKFLOW_READ_ONLY_CONSTRAINT_SECTION,
    `## Output Contract
1. \`## Primary Root Cause\` — certainty and verified linked evidence chain.
2. \`## Confidence Gap\` — why certainty is not higher and what closes it.
3. \`## Alternatives\` — when certainty is below 100%.
4. \`## Proposed Solution\` — describe only; do not write code.
5. \`## Verification Checklist\` — durable links and exact reproducible commands.`,
  ];
}

export function buildInvestigationSynthesisPrompt(
  input: Parameters<typeof buildInvestigationSynthesisPromptSections>[0],
): string {
  return joinPromptSections(buildInvestigationSynthesisPromptSections(input));
}
