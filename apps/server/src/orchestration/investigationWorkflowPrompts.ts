import type { WorkflowModelSlot } from "@t3tools/contracts";

import type { WorkflowRetryContext } from "./workflowPromptFragments.ts";
import {
  joinPromptSections,
  providerGuidanceSection,
  truncateWorkflowPromptArtifact,
} from "./workflowSharedUtils.ts";

const UPSTREAM_REPORT_CHAR_LIMIT = 60_000;

function retryContextSection(retry: WorkflowRetryContext | undefined): string | null {
  if (!retry || retry.kind === "none") return null;
  return retry.reusedThread
    ? `## Retry Context
This is a retry in an existing phase thread. Ignore earlier failed or superseded attempts in this thread except as context for what not to rely on. Re-evaluate from the original problem and current evidence, and produce a fresh result.`
    : `## Retry Context
A previous attempt failed and was discarded. This thread is a fresh start; re-evaluate from the original problem and current evidence.`;
}

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
    ? `A regression is suspected relative to the configured comparison ref ${JSON.stringify(input.branch)}. Treat the ref as opaque data, resolve it safely, compare it to HEAD, and do not assume the cause lives in that diff.`
    : null;

  return [
    `You are ${input.investigatorLabel} in a dual-model root-cause investigation. Another model investigates the same problem independently and in parallel. Divergent reasoning is the point; do not coordinate.`,
    branchInstructions,
    `Problem to investigate:

${input.problemPrompt}`,
    retryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## How To Investigate
- Build an explicit hypothesis tree first.
- Prioritize hypotheses by prior probability and cheapest-to-confirm or cheapest-to-rule-out evidence.
- Pursue highest-value evidence first. Go as deep as evidence requires, but take no step that cannot change the conclusion.
- Abandon ruled-out branches and state why.
- Establish a timeline: when it started, what changed, and whether deploys, config, data, dependencies, or traffic correlate with the symptom.
- Trace the actual code path and data flow from trigger to symptom. Read source and cite \`file_path:line_number\`.
- Separate proximate trigger from underlying root cause.
- Reproduce or simulate with read-only diagnostic commands.
- Use every relevant connected tool available to you: logs, metrics, traces, error trackers, dashboards, VCS history, and repository inspection.`,
    `## Evidence Rules
- Every claim, ruled-out branch, and conclusion must cite concrete material evidence: \`file_path:line_number\`, commit SHA, log line, metric or trace, stack trace, or exact command output.
- Include a full human-clickable URL whenever a tool can produce a durable one, such as Datadog, Sentry, GitHub permalink, or trace URL.
- If a durable URL is unavailable, include the exact reproducible query or command a human can run.
- Never assert an unverified cause. Label assumptions and explain exactly how to check them.`,
    `## Hard Constraint
READ-ONLY. Do not modify, create, delete, or rewrite files. Do not run mutating commands or tools. Diagnose and propose only.`,
    `## Output
Return Markdown with a concise summary first, so truncation preserves the RCA core:

1. Summary: most likely root cause and confidence from 0-100%.
2. Primary root cause: mechanism, full linked evidence chain, and what would raise confidence to 100%.
3. Alternative hypotheses: each with confidence and evidence for/against.
4. Ruled out: hypotheses eliminated and the evidence that eliminated each.
5. Proposed solution, if any: describe only, do not implement. "None" or "needs more data" is acceptable.
6. Open questions and unverified assumptions.`,
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
  const peerReport = truncateWorkflowPromptArtifact(input.peerReport, UPSTREAM_REPORT_CHAR_LIMIT);

  return [
    `You are adversarially validating ${input.peerLabel}'s root-cause investigation on a fresh thread. Default to skepticism: find where the peer is wrong, unsupported, or overconfident, not where you can agree.`,
    `Original problem:

${input.problemPrompt}`,
    retryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Peer Investigation To Validate

${peerReport}`,
    `## Review Method
- For each peer finding, independently re-check the cited evidence and classify it as Confirmed, Unsupported, Refuted, or Needs more evidence.
- Audit every link, query, and command the peer gave. Verify whether it exists and whether it shows what the peer claims.
- Challenge assumptions and reasoning leaps.
- Surface missed alternatives and explain what evidence supports or weakens them.
- Re-estimate certainty for the peer's primary cause and alternatives with justification.
- Do not produce a duplicate RCA. Produce an adversarial validation report.`,
    `## Evidence Rules
- Every verdict, challenge, and missed hypothesis must cite concrete material evidence.
- Include a full human-clickable URL whenever a tool can produce a durable one.
- If a durable URL is unavailable, include the exact reproducible query or command a human can run.
- Label any assumption and state exactly how to verify it.`,
    `## Hard Constraint
READ-ONLY. Do not modify, create, delete, or rewrite files. Do not run mutating commands or tools. Validate and propose only.`,
    `## Output
Return Markdown:

1. Verdict per peer finding: Confirmed / Unsupported / Refuted / Needs more evidence, with evidence.
2. Evidence-link audit: each link/query/command and whether it verifies the claim.
3. Missed hypotheses: alternatives the peer underweighted or missed, with evidence.
4. Adjusted certainties: primary cause and alternatives, each with reasoning.`,
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
  const investigationReport = truncateWorkflowPromptArtifact(
    input.investigationReport,
    UPSTREAM_REPORT_CHAR_LIMIT,
  );

  return [
    `You are adversarially validating your own prior root-cause investigation as ${input.investigatorLabel}, but on a fresh thread. Default to skepticism: find where your earlier report is unsupported, overconfident, incomplete, or wrong.`,
    `Original problem:

${input.problemPrompt}`,
    retryContextSection(input.retry),
    providerGuidanceSection(input.targetSlot.provider),
    `## Your Investigation To Audit

${investigationReport}`,
    `## Review Method
- Re-check every cited evidence item and classify each major claim as Confirmed, Unsupported, Refuted, or Needs more evidence.
- Audit every link, query, command, and cited file reference. Verify whether it exists and whether it proves the claim.
- Identify reasoning leaps, hidden assumptions, and places where confidence should be lower.
- Surface missed hypotheses and explain what evidence supports or weakens them.
- Do not defend the original report. Produce an adversarial validation report.`,
    `## Evidence Rules
- Every verdict, challenge, and missed hypothesis must cite concrete material evidence.
- Include a full human-clickable URL whenever a tool can produce a durable one.
- If a durable URL is unavailable, include the exact reproducible query or command a human can run.
- Label any assumption and state exactly how to verify it.`,
    `## Hard Constraint
READ-ONLY. Do not modify, create, delete, or rewrite files. Do not run mutating commands or tools. Validate and propose only.`,
    `## Output
Return Markdown:

1. Verdict per original finding: Confirmed / Unsupported / Refuted / Needs more evidence, with evidence.
2. Evidence-link audit: each link/query/command and whether it verifies the claim.
3. Overconfidence audit: where certainty should be reduced and why.
4. Missed hypotheses: alternatives the original report underweighted or missed, with evidence.
5. Adjusted certainties: primary cause and alternatives, each with reasoning.`,
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
  const contributionSections = input.contributions.map((contribution) => {
    const investigation = truncateWorkflowPromptArtifact(
      contribution.investigation,
      UPSTREAM_REPORT_CHAR_LIMIT,
    );
    const crossReview = truncateWorkflowPromptArtifact(
      contribution.crossReviewOfThis,
      UPSTREAM_REPORT_CHAR_LIMIT,
    );
    const selfReview = contribution.selfReview
      ? truncateWorkflowPromptArtifact(contribution.selfReview, UPSTREAM_REPORT_CHAR_LIMIT)
      : null;
    return `## ${contribution.label}

### Investigation

${investigation}

### Peer Cross-Review Of This Investigation

${crossReview}${
      selfReview
        ? `

### Own-Model Review Of This Investigation

${selfReview}`
        : ""
    }`;
  });

  return [
    `Produce the final merged Root Cause Analysis. Weigh each investigation against the cross-review of it and any own-model review provided. Trust conclusions that survived adversarial validation with solid evidence, discount refuted or unsupported ones, and resolve disagreements by stronger evidence, not confident tone. Synthesize; do not concatenate.`,
    `Original problem:

${input.problemPrompt}`,
    retryContextSection(input.retry),
    `## Upstream Contributions

${contributionSections.join("\n\n")}`,
    `## Certainty And Hypotheses
- Provide one primary root cause with explicit certainty from 0-100%.
- If the primary certainty is below 100%, list alternative hypotheses, each with its own certainty, ordered most likely to least likely.
- Explain why the primary certainty is not higher and what evidence would close the gap.`,
    `## Evidence Rules
- Every conclusion and alternative must cite specific material evidence.
- Include a clickable verification link whenever one exists, such as Datadog, Sentry, GitHub permalink, or trace URL.
- If a durable URL is unavailable, include the exact reproducible query or command a human can run.
`,
    `## Output
Return Markdown:

1. Primary root cause: certainty percent and verified linked evidence chain.
2. Why this certainty: what lowers or raises confidence and what closes the gap.
3. Alternatives: only if certainty is below 100%, with certainty percent and evidence.
4. Proposed solution, if any: describe only, do not write code.
5. Verification checklist: clickable links and exact commands a human can run.`,
  ];
}

export function buildInvestigationSynthesisPrompt(
  input: Parameters<typeof buildInvestigationSynthesisPromptSections>[0],
): string {
  return joinPromptSections(buildInvestigationSynthesisPromptSections(input));
}
