import { describe, expect, it } from "vitest";

import { buildCodeReviewReviewerPrompt } from "./codeReviewWorkflowPrompts.ts";

describe("codeReviewWorkflowPrompts", () => {
  it("adds standalone reviewer guidance for claude reviewers", () => {
    const text = buildCodeReviewReviewerPrompt({
      reviewPrompt: "Review the implementation for regressions.",
      reviewerLabel: "Reviewer B",
      branch: "main",
      provider: "claudeAgent",
    });

    expect(text).toContain("git diff main");
    expect(text).toContain("file_path:line_number");
    expect(text).toContain("blast radius");
    expect(text).toContain("OWASP Top 10");
    expect(text).toContain("Prefer dedicated tools over shell commands");
  });

  it("keeps standalone reviewer prompts generic when provider is unset", () => {
    const text = buildCodeReviewReviewerPrompt({
      reviewPrompt: "Review the implementation for regressions.",
      reviewerLabel: "Reviewer A",
      branch: null,
    });

    expect(text).toContain("Review the current workspace changes using git diff");
    expect(text).not.toContain("Prefer dedicated tools over shell commands");
    expect(text).not.toContain("prefer `rg` and `rg --files`");
  });
});
