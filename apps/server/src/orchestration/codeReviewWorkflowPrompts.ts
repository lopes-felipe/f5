import type { CodeReviewPullRequest, WorkflowModelSlot } from "@t3tools/contracts";
import { codeReviewPullRequestMarkdownLink } from "@t3tools/shared/codeReviewPullRequest";

import type { WorkflowRetryContext } from "./workflowPromptFragments.ts";
import {
  allocateArtifactCharBudget,
  joinPromptSections,
  providerGuidanceSection,
} from "./workflowSharedUtils.ts";

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

export interface CodeReviewConsolidationReviewInput {
  readonly label: string;
  readonly text: string;
  readonly turnId?: string | undefined;
  readonly messageId?: string | undefined;
}

export interface CodeReviewConsolidationPromptInput {
  readonly workflowId: string;
  readonly reviewPrompt: string;
  readonly reviews: ReadonlyArray<CodeReviewConsolidationReviewInput>;
  readonly consolidationSlot: WorkflowModelSlot;
  readonly pullRequest?: CodeReviewPullRequest | null | undefined;
  readonly retry?: WorkflowRetryContext | undefined;
}

const REVIEW_COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

function excerptNote(label: string, shown: number, total: number): string {
  return `[Excerpt: the first ${shown} of ${total} characters of the ${label} report. The rest is not available to you.]`;
}

/**
 * The most an excerpt note (and its separator) can add to a report. It names the report's label,
 * so it is measured rather than assumed: `shown` never has more digits than `total`.
 */
function excerptNoteReserve(label: string, total: number): number {
  return `\n\n${excerptNote(label, total, total)}`.length;
}

export function buildCodeReviewConsolidationPromptSections(
  input: CodeReviewConsolidationPromptInput,
  options?: { readonly excerpted?: boolean },
): ReadonlyArray<string | null | undefined> {
  const reviewSections = input.reviews.map(
    (review) => `## ${review.label}\n\n${review.text.trim()}`,
  );
  const count = input.reviews.length;

  return [
    `You are consolidating ${REVIEW_COUNT_WORDS[count] ?? String(count)} independent code reviews into one final report.

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

${
  options?.excerpted
    ? "Some reports were too long to include whole. Each excerpt is marked. Work from what is shown, and say in the consolidated review which findings come from a shortened report.\n\n"
    : ""
}${reviewSections.join("\n\n")}

Do not write code. Return only the consolidated review. Reply with the complete report as your message; do not submit it as a plan.`,
  ];
}

export function buildCodeReviewConsolidationPrompt(
  input: CodeReviewConsolidationPromptInput,
): string {
  return joinPromptSections(buildCodeReviewConsolidationPromptSections(input));
}

/**
 * The consolidation prompt for a run with more than two reviewers, kept within
 * `maxRenderedChars`: the room left after the fixed text is shared among the reports with
 * `allocateArtifactCharBudget`, and a report that does not fit whole is cut and marked.
 * `smallestExcerpt` is the smallest share an excerpted report got (`null` when all fit), so the
 * caller can refuse a consolidation that would show too little of a report. `reviewTexts` are the
 * reports as rendered.
 */
export function buildBudgetedCodeReviewConsolidationPrompt(
  input: CodeReviewConsolidationPromptInput & { readonly maxRenderedChars: number },
): {
  readonly prompt: string;
  readonly smallestExcerpt: number | null;
  readonly reviewTexts: ReadonlyArray<string>;
} {
  const texts = input.reviews.map((review) => review.text.trim());
  // Reports that fit whole are sent whole; excerpt-note space is reserved only when cutting.
  const whole = joinPromptSections(
    buildCodeReviewConsolidationPromptSections({
      ...input,
      reviews: input.reviews.map((review, index) => ({ ...review, text: texts[index]! })),
    }),
  );
  if (whole.length <= input.maxRenderedChars) {
    return { prompt: whole, smallestExcerpt: null, reviewTexts: texts };
  }
  const fixedLength = joinPromptSections(
    buildCodeReviewConsolidationPromptSections(
      { ...input, reviews: input.reviews.map((review) => ({ ...review, text: "" })) },
      { excerpted: true },
    ),
  ).length;
  const noteReserve = input.reviews.reduce(
    (sum, review, index) => sum + excerptNoteReserve(review.label, texts[index]!.length),
    0,
  );
  const budget = input.maxRenderedChars - fixedLength - noteReserve;
  const { allowances, smallestExcerpt } = allocateArtifactCharBudget(
    texts.map((text) => text.length),
    budget,
  );
  const reviews = input.reviews.map((review, index) => {
    const text = texts[index]!;
    const allowance = allowances[index]!;
    return allowance >= text.length
      ? { ...review, text }
      : {
          ...review,
          text: `${text.slice(0, allowance)}\n\n${excerptNote(review.label, allowance, text.length)}`,
        };
  });
  return {
    prompt: joinPromptSections(
      buildCodeReviewConsolidationPromptSections(
        { ...input, reviews },
        { excerpted: smallestExcerpt !== null },
      ),
    ),
    smallestExcerpt,
    reviewTexts: reviews.map((review) => review.text),
  };
}
