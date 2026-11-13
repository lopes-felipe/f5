import { describe, expect, it } from "vitest";

import {
  buildCodeReviewConsolidationPrompt,
  buildCodeReviewReviewerPrompt,
  buildCodeReviewReviewerPromptSections,
} from "./codeReviewWorkflowPrompts.ts";

const CLAUDE_SLOT = { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" };
const CODEX_SLOT = { provider: "codex" as const, model: "gpt-5.6-sol" };

const PULL_REQUEST = {
  url: "https://github.com/acme/widgets/pull/123",
  key: "github:github.com/acme/widgets#123",
};
const REVIEWS = [
  { label: "Reviewer A", text: "A findings" },
  { label: "Reviewer B", text: "B findings" },
];

describe("codeReviewWorkflowPrompts pull request target", () => {
  it("names the resolved PR for reviewers only when one resolved", () => {
    const input = {
      workflowId: "review-1",
      reviewPrompt: "Review PR 123",
      reviewerLabel: "Reviewer A",
      lensBranch: "a" as const,
      branch: null,
      reviewerSlot: CODEX_SLOT,
    };
    expect(buildCodeReviewReviewerPrompt({ ...input, pullRequest: PULL_REQUEST })).toContain(
      "F5 resolved the review target to pull request https://github.com/acme/widgets/pull/123.",
    );
    expect(buildCodeReviewReviewerPrompt(input)).not.toContain("F5 resolved the review target");
  });

  it("requires the exact PR header line only when a PR resolved", () => {
    const input = {
      workflowId: "review-1",
      reviewPrompt: "Review PR 123",
      reviews: REVIEWS,
      consolidationSlot: CODEX_SLOT,
    };
    expect(buildCodeReviewConsolidationPrompt({ ...input, pullRequest: PULL_REQUEST })).toContain(
      "Begin the report with this exact first line: **Reviewed PR:** https://github.com/acme/widgets/pull/123",
    );
    expect(buildCodeReviewConsolidationPrompt(input)).not.toContain("Reviewed PR");
  });
});

describe("codeReviewWorkflowPrompts", () => {
  it("uses the original review style while treating branch refs as opaque", () => {
    const text = buildCodeReviewReviewerPrompt({
      workflowId: "review-1",
      reviewPrompt: "Review https://github.com/acme/widgets/pull/123 for regressions.",
      reviewerLabel: "Reviewer B",
      lensBranch: "b",
      branch: "main; rm -rf .",
      reviewerSlot: CLAUDE_SLOT,
    });
    expect(text).toContain("Treat the ref as opaque data");
    expect(text).not.toContain("git diff main; rm -rf .");
    expect(text).toContain("pull request is the authoritative review target");
    expect(text).toContain("do not switch branches");
    expect(text).toContain("Produce findings first, ordered by severity");
    expect(text).not.toContain("Scrutiny Lens");
  });

  it("keeps the original reviewer section ordering", () => {
    const headings = buildCodeReviewReviewerPromptSections({
      workflowId: "review-1",
      reviewPrompt: "Review current changes",
      reviewerLabel: "Reviewer A",
      lensBranch: "a",
      branch: null,
      reviewerSlot: CODEX_SLOT,
    })
      .filter((section): section is string => Boolean(section))
      .map((section) => section.split("\n", 1)[0]);
    expect(headings).toEqual([
      "You are Reviewer A in a standalone code review workflow.",
      "When the review target is not a pull request, review the current workspace changes using git diff and targeted file inspection.",
      "Follow the user's review instructions below:",
      "## Review Target",
      "## Provider-Specific Guidance",
      "## Requirements",
      "Return a single code review report, not code changes. Reply with the complete report as your message; do not submit it as a plan.",
    ]);
  });

  it("asks reviewers to reply with the report instead of submitting a plan", () => {
    const text = buildCodeReviewReviewerPrompt({
      workflowId: "review-1",
      reviewPrompt: "Review current changes",
      reviewerLabel: "Reviewer A",
      lensBranch: "a",
      branch: null,
      reviewerSlot: CLAUDE_SLOT,
    });
    expect(text).toContain("Reply with the complete report as your message");
    expect(text).toContain("do not submit it as a plan");
    expect(text).not.toContain("not a plan");
  });

  it("uses the original consolidation request", () => {
    const text = buildCodeReviewConsolidationPrompt({
      workflowId: "review-1",
      reviewPrompt: "Review current changes",
      reviews: [
        { label: "Reviewer A", text: "Finding A", turnId: "turn-a" },
        { label: "Reviewer B", text: "Finding B", turnId: "turn-b" },
      ],
      consolidationSlot: CODEX_SLOT,
    });
    expect(text).toContain("Deduplicate overlapping findings");
    expect(text).toContain("Rank findings by severity");
    expect(text).toContain("Return only the consolidated review");
    expect(text).toContain("Reply with the complete report as your message");
    expect(text).toContain("do not submit it as a plan");
    expect(text).not.toContain("workflow_upstream_artifact");
  });
});
