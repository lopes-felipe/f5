import type { CodeReviewPullRequest, WorkflowModelSlot } from "@t3tools/contracts";
import { codeReviewPullRequestMarkdownLink } from "@t3tools/shared/codeReviewPullRequest";

import type { WorkflowRetryContext } from "./workflowPromptFragments.ts";
import { joinPromptSections, providerGuidanceSection } from "./workflowSharedUtils.ts";

export function buildCodeReviewReviewerPromptSections(input: {
  readonly workflowId: string;
  readonly reviewPrompt: string;
  readonly reviewerLabel: string;
  readonly lensBranch: "a" | "b";
  readonly branch: string | null;
  readonly reviewerSlot: WorkflowModelSlot;
  readonly pullRequest?: CodeReviewPullRequest | null | undefined;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  const branchInstructions = input.branch
    ? `When the review target is not a pull request, review the changes by safely resolving the configured comparison ref ${JSON.stringify(input.branch)} and comparing the current workspace against it. Treat the ref as opaque data and never interpolate it into an executable shell command.`
    : "When the review target is not a pull request, review the current workspace changes using git diff and targeted file inspection.";

  return [
    `You are ${input.reviewerLabel} in a standalone code review workflow.`,
    branchInstructions,
    `Follow the user's review instructions below:

${input.reviewPrompt}`,
    `## Review Target
${input.pullRequest ? `- F5 resolved the review target to pull request ${input.pullRequest.url}.\n` : ""}- Resolve the exact review target from the user's instructions before inspecting changes.
- If the user's instructions identify a pull request by URL or number, that pull request is the authoritative review target. Verify whether the local checkout represents the pull request's head before relying on workspace state or a local diff.
- If the local checkout does not represent the requested pull request, do not review the locally checked-out branch and do not switch branches. Use available Git/GitHub skills, APIs, or CLI tools to retrieve the actual pull request metadata, base and head revisions, diff, and relevant file contents.
- If the requested pull request cannot be accessed, state that the review cannot be completed. Do not substitute the local checkout or another branch as the review target.`,
    providerGuidanceSection(input.reviewerSlot.provider),
    `## Requirements
- Do not modify any files.
- Produce findings first, ordered by severity.
- Use \`file_path:line_number\` for every code-specific finding.
- Be specific, actionable, and focused on correctness, regressions, reliability, failure modes, maintainability, and missing tests.
- Assess blast radius for material issues: distinguish local, reversible problems from broad or hard-to-reverse changes.
- Review security with OWASP Top 10 awareness, including injection, access control, auth/session handling, unsafe path or file handling, SSRF, XSS, and sensitive-data exposure.
- Flag extra features, speculative cleanup, or scope expansion that the user did not ask for.`,
    "Return a single code review report, not code changes. Reply with the complete report as your message; do not submit it as a plan.",
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
  readonly pullRequest?: CodeReviewPullRequest | null | undefined;
  readonly retry?: WorkflowRetryContext | undefined;
}): ReadonlyArray<string | null | undefined> {
  const reviewSections = input.reviews.map(
    (review) => `## ${review.label}\n\n${review.text.trim()}`,
  );

  return [
    `You are consolidating two independent code reviews into one final report.

Original review instructions:

${input.reviewPrompt}

Your job:
- Deduplicate overlapping findings.
- Rank findings by severity.
- Resolve disagreements by choosing the stronger technical assessment.
- Keep only high-signal findings.
- Return one unified code review report.

Report layout:
- Start with a \`#\` title that names what was reviewed${
      input.pullRequest
        ? `, linking the pull request as ${codeReviewPullRequestMarkdownLink(input.pullRequest)}`
        : ""
    }.
- Under the title, add short **Target:** (what was reviewed, with commits when known), **Verdict:** (one line) and **Verification:** (what was run or checked, as bullets) lines.
- Group findings under severity headings (\`## High\`, \`## Medium\`, \`## Low\`), omitting empty ones.
- Number each finding and give it a short bold title followed by its \`file_path:line_number\`. Put the evidence, impact and fix in bullets, not long paragraphs.
- Write nothing before the title: no narration about what you checked or are about to write.

${reviewSections.join("\n\n")}

Do not write code. Return only the consolidated review. Reply with the complete report as your message; do not submit it as a plan.`,
  ];
}

export function buildCodeReviewConsolidationPrompt(
  input: Parameters<typeof buildCodeReviewConsolidationPromptSections>[0],
): string {
  return joinPromptSections(buildCodeReviewConsolidationPromptSections(input));
}
