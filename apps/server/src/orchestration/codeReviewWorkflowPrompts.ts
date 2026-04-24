import type { ProviderKind } from "@t3tools/contracts";

import { joinPromptSections, providerGuidanceSection } from "./workflowSharedUtils.ts";

export function buildCodeReviewReviewerPrompt(input: {
  readonly reviewPrompt: string;
  readonly reviewerLabel: string;
  readonly branch: string | null;
  readonly provider?: ProviderKind;
}): string {
  const branchInstructions = input.branch
    ? `Review the changes by comparing the current workspace against \`${input.branch}\`, using commands like \`git diff ${input.branch}\` and targeted file inspection.`
    : "Review the current workspace changes using git diff and targeted file inspection.";

  return joinPromptSections([
    `You are ${input.reviewerLabel} in a standalone code review workflow.`,
    branchInstructions,
    `Follow the user's review instructions below:

${input.reviewPrompt}`,
    providerGuidanceSection(input.provider),
    `## Requirements
- Do not modify any files.
- Produce findings first, ordered by severity.
- Use \`file_path:line_number\` for every code-specific finding.
- Be specific, actionable, and focused on correctness, regressions, reliability, failure modes, maintainability, and missing tests.
- Assess blast radius for material issues: distinguish local, reversible problems from broad or hard-to-reverse changes.
- Review security with OWASP Top 10 awareness, including injection, access control, auth/session handling, unsafe path or file handling, SSRF, XSS, and sensitive-data exposure.
- Flag extra features, speculative cleanup, or scope expansion that the user did not ask for.`,
    "Return a single code review report, not a plan and not code changes.",
  ]);
}

export function buildCodeReviewConsolidationPrompt(input: {
  readonly reviewPrompt: string;
  readonly reviews: ReadonlyArray<{
    readonly label: string;
    readonly text: string;
  }>;
}): string {
  const reviewSections = input.reviews.map(
    (review) => `## ${review.label}\n\n${review.text.trim()}`,
  );

  return `You are consolidating two independent code reviews into one final report.

Original review instructions:

${input.reviewPrompt}

Your job:
- Deduplicate overlapping findings.
- Rank findings by severity.
- Resolve disagreements by choosing the stronger technical assessment.
- Keep only high-signal findings.
- Return one unified code review report.

${reviewSections.join("\n\n")}

Do not write code. Do not produce a plan. Return only the consolidated review.`;
}
