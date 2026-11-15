import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrHubAdvisory, TrackedPullRequest } from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";

import { PrPageContent } from "./PrPageContent";
import { TooltipProvider } from "../ui/tooltip";

function makePr(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#1"),
    provider: "github",
    capabilities: [
      { action: "approve", supported: true },
      { action: "comment", supported: true },
      { action: "request-changes", supported: true },
    ],
    nodeId: "PR_1",
    number: 1,
    title: "Improve advisory flow",
    url: "https://github.com/octo/repo/pull/1",
    repository: {
      owner: "octo",
      repo: "repo",
      nameWithOwner: "octo/repo",
    },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "ci_failing",
    attentionBucket: "needs_you",
    primaryReason: "CI failing",
    nextAction: "Fix failing CI",
    checkRollup: "failure",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: ["alice"],
    reviewRequestsCount: 1,
    commentsCount: 2,
    unresolvedThreadCount: 1,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    headRefOid: "head-1",
    baseRefName: "main",
    headRefName: "feature/advisory",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fingerprint-1",
    ...overrides,
  };
}

function makeAdvisory(pr: TrackedPullRequest): PrHubAdvisory {
  return {
    key: pr.key,
    status: "succeeded",
    recommendation: "fix_ci",
    summary: "Fix failing CI before requesting more review.",
    confidence: 90,
    blockers: ["build"],
    findings: [
      {
        id: "comment-1",
        url: "https://github.com/octo/repo/pull/1#discussion_r1",
        author: "alice",
        category: "review_thread",
        validity: "valid",
        summary: "src/file.ts:10: This must handle null.",
        rationale: "The comment contains concrete blocking or corrective language.",
      },
    ],
    fingerprint: "advisory-fingerprint",
    generatedAt: "2026-01-02T01:00:00.000Z",
    stale: false,
    degraded: false,
    truncated: false,
  };
}

function render(node: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={0}>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("PrPageContent", () => {
  it("renders the header, the status checklist, the advisory and the tabs", () => {
    const pr = makePr();
    const markup = render(
      <PrPageContent pr={pr} advisory={makeAdvisory(pr)} onAnalyzeAdvisory={() => {}} />,
    );

    expect(markup).toContain("octo/repo#1");
    expect(markup).toContain("feature/advisory → main");
    expect(markup).toContain("2 files");
    // The author's next step for failing CI, and the checklist line behind it.
    expect(markup).toContain("Fix CI");
    expect(markup).toContain("Some checks failed");
    expect(markup).toContain("View checks");
    expect(markup).toContain("1 unresolved");
    expect(markup).toContain("90%");
    expect(markup).toContain("Fix failing CI before requesting more review.");
    for (const tab of ["Overview", "Conversation", "Threads (1)", "Files (2)", "Checks", "Guide"]) {
      expect(markup).toContain(tab);
    }
    // Sync diagnostics are folded away, not listed above the description.
    expect(markup).toContain("Sync details");
    expect(markup).not.toContain("Merge requirements");
    // Secondary actions live in a portalled, closed overflow menu; assert the
    // always-rendered trigger instead.
    expect(markup).toContain('aria-label="More actions"');
    expect(markup).toContain('aria-label="Merge options"');
  });

  it("offers a reviewer the review choices instead of the merge ones", () => {
    const pr = makePr({
      roles: ["review_requested"],
      author: "alice",
      viewerReviewRequested: true,
      attentionState: "review_requested",
      attentionBucket: "needs_you",
    });
    const markup = render(<PrPageContent pr={pr} />);

    expect(markup).toContain('aria-label="Review options"');
    expect(markup).not.toContain('aria-label="Merge options"');
    expect(markup).toContain('aria-label="More actions"');
  });

  it("shows a merged pull request without steps that no longer apply", () => {
    const markup = render(
      <PrPageContent
        pr={makePr({ state: "merged", attentionState: "merged", attentionBucket: "informational" })}
      />,
    );

    expect(markup).toContain("Merged");
    expect(markup).not.toContain("Snooze");
    expect(markup).not.toContain('aria-label="Merge options"');
    expect(markup).not.toContain('aria-label="Status"');
  });
});
