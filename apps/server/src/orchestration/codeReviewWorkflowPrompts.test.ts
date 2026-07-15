import { describe, expect, it } from "vitest";

import { buildCodeReviewReviewerPrompt } from "./codeReviewWorkflowPrompts.ts";

describe("codeReviewWorkflowPrompts", () => {
  it("adds standalone reviewer guidance for claude reviewers", () => {
    const text = buildCodeReviewReviewerPrompt({
      reviewPrompt: "Review https://github.com/acme/widgets/pull/123 for regressions.",
      reviewerLabel: "Reviewer B",
      branch: "main",
      provider: "claudeAgent",
    });

    expect(text).toContain("git diff main");
    expect(text).toContain("When the review target is not a pull request");
    expect(text).toContain("pull request is the authoritative review target");
    expect(text).toContain("do not review the locally checked-out branch");
    expect(text).toContain("do not switch branches");
    expect(text).toContain("Git/GitHub skills, APIs, or CLI tools");
    expect(text).toContain("Do not substitute the local checkout");
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

    expect(text).toContain(
      "When the review target is not a pull request, review the current workspace changes using git diff",
    );
    expect(text).toContain("pull request is the authoritative review target");
    expect(text).not.toContain("Prefer dedicated tools over shell commands");
    expect(text).not.toContain("prefer `rg` and `rg --files`");
  });

  it("keeps pull requests authoritative without a configured comparison branch", () => {
    const text = buildCodeReviewReviewerPrompt({
      reviewPrompt: "Review PR #456 in acme/widgets.",
      reviewerLabel: "Reviewer A",
      branch: null,
      provider: "codex",
    });

    expect(text).toContain("pull request is the authoritative review target");
    expect(text).toContain("Verify whether the local checkout represents the pull request's head");
    expect(text).toContain("do not review the locally checked-out branch");
    expect(text).toContain("do not switch branches");
    expect(text).toContain("actual pull request metadata, base and head revisions, diff");
    expect(text).toContain("review cannot be completed");
    expect(text).toContain("Do not substitute the local checkout");
  });
});
