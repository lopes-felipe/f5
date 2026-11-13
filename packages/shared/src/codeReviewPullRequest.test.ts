import { describe, expect, it } from "vitest";

import {
  codeReviewPostFooter,
  codeReviewPullRequestLabel,
  detectCodeReviewPullRequestShorthand,
  detectCodeReviewPullRequestTarget,
  formatCodeReviewReport,
  githubPullRequestFromRemote,
  isGitHubCodeReviewPullRequest,
} from "./codeReviewPullRequest";

const PR = {
  url: "https://github.com/acme/app/pull/42",
  key: "github:github.com/acme/app#42",
};

describe("detectCodeReviewPullRequestTarget", () => {
  it("canonicalizes the first PR URL", () => {
    expect(
      detectCodeReviewPullRequestTarget(
        "Review https://github.com/acme/app/pull/42/files?w=1. Also see PR 7.",
      ),
    ).toEqual({
      kind: "url",
      ref: { provider: "github", host: "github.com", repository: "acme/app", number: 42 },
      url: "https://github.com/acme/app/pull/42",
    });
  });

  it("ignores non-PR URLs and falls back to shorthand", () => {
    expect(
      detectCodeReviewPullRequestTarget("See https://github.com/acme/app/issues/3 and review PR 9"),
    ).toEqual({ kind: "number", number: 9 });
  });

  it("keeps non-GitHub PR URLs as link targets", () => {
    const target = detectCodeReviewPullRequestTarget(
      "https://gitlab.com/acme/app/-/merge_requests/5/diffs",
    );
    expect(target).toMatchObject({
      kind: "url",
      ref: { provider: "gitlab", number: 5 },
      url: "https://gitlab.com/acme/app/-/merge_requests/5",
    });
  });

  it("returns null without a target", () => {
    expect(detectCodeReviewPullRequestTarget("Review my local changes")).toBeNull();
  });
});

describe("detectCodeReviewPullRequestShorthand", () => {
  it.each([
    ["review pr 123 please", 123],
    ["Review PR #123", 123],
    ["Review PR#123", 123],
    ["Review pull request 123", 123],
    ["(PR #123)", 123],
    ["PR #123, then pull request 123 again", 123],
  ])("detects %s", (prompt, expected) => {
    expect(detectCodeReviewPullRequestShorthand(prompt)).toBe(expected);
  });

  it.each([
    "Review #123",
    "fix issue #482",
    "My #1 concern is security",
    "color changed to #123456",
    "Review branch feat/x (follow-up to #610)",
    "step #3 of the runbook",
    "Review PR 12 and PR 13",
    "SPR 12",
    "abc#123",
    "&#123;",
    "# 123 heading",
    "https://github.com/acme/app/pull/5#issuecomment-123",
    "approve 123",
    "april 2024",
  ])("rejects %s", (prompt) => {
    expect(detectCodeReviewPullRequestShorthand(prompt)).toBeNull();
  });
});

describe("githubPullRequestFromRemote", () => {
  it("resolves SSH and HTTPS GitHub remotes", () => {
    expect(githubPullRequestFromRemote("git@github.com:acme/app.git", 42)).toEqual(PR);
    expect(githubPullRequestFromRemote("https://github.com/acme/app", 42)).toEqual(PR);
  });

  it("rejects non-GitHub remotes", () => {
    expect(githubPullRequestFromRemote("git@gitlab.com:acme/app.git", 42)).toBeNull();
    expect(githubPullRequestFromRemote(null, 42)).toBeNull();
  });
});

describe("pull request helpers", () => {
  it("labels and classifies the PR", () => {
    expect(codeReviewPullRequestLabel(PR)).toBe("acme/app#42");
    expect(isGitHubCodeReviewPullRequest(PR)).toBe(true);
    expect(
      isGitHubCodeReviewPullRequest({
        url: "https://gitlab.com/acme/app/-/merge_requests/5",
        key: "gitlab:gitlab.com/acme/app#5",
      }),
    ).toBe(false);
    expect(isGitHubCodeReviewPullRequest(null)).toBe(false);
  });
});

describe("formatCodeReviewReport", () => {
  it("adds the PR header when the report omits the URL", () => {
    expect(formatCodeReviewReport("## Findings\n- none\n", { pullRequest: PR })).toBe(
      "**Reviewed PR:** [acme/app#42](https://github.com/acme/app/pull/42)\n\n## Findings\n- none",
    );
  });

  it("does not duplicate a header the model already wrote", () => {
    const text = `**Reviewed PR:** ${PR.url}\n\n## Findings`;
    expect(formatCodeReviewReport(text, { pullRequest: PR })).toBe(text);
  });

  it("keeps a title that links the PR and adds nothing", () => {
    const text = `# Consolidated review: [acme/app#42](${PR.url})\n\n**Verdict:** ship it`;
    expect(formatCodeReviewReport(text, { pullRequest: PR })).toBe(text);
  });

  it("puts the header under a title that does not link the PR", () => {
    expect(
      formatCodeReviewReport("# Consolidated review\n\n## Medium\n1. x", { pullRequest: PR }),
    ).toBe(`# Consolidated review\n\n**Reviewed PR:** [acme/app#42](${PR.url})\n\n## Medium\n1. x`);
  });

  it("drops narration before the linked header and does not repeat it", () => {
    const text = `I checked the main claims and am now writing the merged report.\n\n**Reviewed PR:** ${PR.url}\n\nHead abc.`;
    expect(formatCodeReviewReport(text, { pullRequest: PR })).toBe(
      `**Reviewed PR:** ${PR.url}\n\nHead abc.`,
    );
  });

  it("adds the header when the URL only appears later or as a longer PR number", () => {
    const later = `## Findings\n- one\n- two\n- three\n- see ${PR.url}`;
    expect(formatCodeReviewReport(later, { pullRequest: PR })).toMatch(/^\*\*Reviewed PR:\*\*/);
    const longer = `**Reviewed PR:** ${PR.url}3\n\nbody`;
    expect(formatCodeReviewReport(longer, { pullRequest: PR })).toMatch(
      /^\*\*Reviewed PR:\*\* \[acme\/app#42\]/,
    );
  });

  it("leaves reports without a PR unchanged apart from trimming", () => {
    expect(formatCodeReviewReport("  body  ", { pullRequest: null })).toBe("body");
  });

  it("appends the footer", () => {
    const footer = codeReviewPostFooter({
      reviewerA: { model: "gpt-5" },
      reviewerB: { model: "claude-opus-5-5" },
      consolidation: { model: "claude-opus-5-5" },
    });
    expect(footer).toBe(
      "<sub>Posted by F5 code review · Reviewers: gpt-5, claude-opus-5-5 · Merge: claude-opus-5-5</sub>",
    );
    expect(formatCodeReviewReport(`${PR.url}\nbody`, { pullRequest: PR, footer })).toBe(
      `${PR.url}\nbody\n\n---\n\n${footer}`,
    );
  });
});
