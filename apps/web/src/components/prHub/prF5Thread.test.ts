import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PullRequestKey,
  type NativeApi,
  type PrHubAdvisory,
  type PrHubUnresolvedThreadsResult,
  type ServerProvider,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  reviewThreadsContext,
  prF5RunLabel,
  buildPrF5Prompt,
  createPrF5Thread,
  resolvePrF5RunKind,
} from "./prF5Thread";

function makePr(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#1"),
    provider: "github",
    nodeId: "PR_1",
    number: 1,
    title: "Fix the build",
    url: "https://github.com/octo/repo/pull/1",
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "ci_failing",
    attentionBucket: "needs_you",
    primaryReason: "CI failing",
    nextAction: "Fix CI",
    checkRollup: "failure",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "BLOCKED",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    headRefOid: "abc123",
    baseRefName: "main",
    headRefName: "fix/build",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fingerprint",
    ...overrides,
  };
}

const advisory: PrHubAdvisory = {
  key: PullRequestKey.makeUnsafe("github.com/octo/repo#1"),
  status: "succeeded",
  recommendation: "fix_ci",
  summary: "The typecheck is failing.",
  confidence: 90,
  blockers: ["typecheck"],
  findings: [],
  fingerprint: "advisory",
  generatedAt: "2026-01-02T01:00:00.000Z",
  stale: false,
  degraded: false,
  truncated: false,
};

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex_custom"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-test",
      name: "GPT Test",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

function makeApi() {
  const preparePullRequestThread = vi.fn(async () => ({
    pullRequest: {
      number: 1,
      title: "Fix the build",
      url: "https://github.com/octo/repo/pull/1",
      baseBranch: "main",
      headBranch: "fix/build",
      headOid: "abc123",
      state: "open" as const,
    },
    branch: "fix/build",
    worktreePath: "/tmp/f5-pr-1",
  }));
  const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
  return {
    api: {
      git: { preparePullRequestThread },
      orchestration: { dispatchCommand },
    } as unknown as NativeApi,
    dispatchCommand,
    preparePullRequestThread,
  };
}

describe("PR Hub F5 threads", () => {
  it("routes failed CI to the investigation template and pins the prompt", () => {
    const pr = makePr();
    expect(resolvePrF5RunKind(pr, advisory)).toBe("investigation");
    const prompt = buildPrF5Prompt({ pr, advisory, kind: "investigation" });
    expect(prompt).toContain("pinned head commit abc123");
    expect(prompt).toContain("git rev-parse HEAD");
    expect(prompt).toContain("Do not commit, push, reply to reviews, approve, close, or merge");
  });

  it("creates a persistent thread for Open in F5", async () => {
    const harness = makeApi();
    await createPrF5Thread({
      api: harness.api,
      candidate: {
        projectId: ProjectId.makeUnsafe("project-1"),
        projectTitle: "Repo",
        cwd: "/repo",
        repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
      },
      pr: makePr(),
      intent: "open",
      preferredModel: "gpt-test",
      providers: [provider],
    });

    expect(harness.preparePullRequestThread).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "worktree", expectedHeadOid: "abc123" }),
    );
    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.create",
        worktreePath: "/tmp/f5-pr-1",
        modelSelection: { instanceId: "codex_custom", model: "gpt-test" },
      }),
    );
  });

  it("bootstraps the fix turn atomically in the isolated worktree", async () => {
    const harness = makeApi();
    await createPrF5Thread({
      api: harness.api,
      candidate: {
        projectId: ProjectId.makeUnsafe("project-1"),
        projectTitle: "Repo",
        cwd: "/repo",
        repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
      },
      pr: makePr(),
      advisory,
      intent: "investigation",
      preferredModel: "gpt-test",
      providers: [provider],
    });

    expect(harness.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        runtimeMode: "approval-required",
        bootstrap: {
          createThread: expect.objectContaining({
            worktreePath: "/tmp/f5-pr-1",
            runtimeMode: "approval-required",
          }),
        },
      }),
    );
  });

  it("requires a refresh when a run has no observed head SHA", async () => {
    const harness = makeApi();
    await expect(
      createPrF5Thread({
        api: harness.api,
        candidate: {
          projectId: ProjectId.makeUnsafe("project-1"),
          projectTitle: "Repo",
          cwd: "/repo",
          repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
        },
        pr: makePr({ headRefOid: null }),
        intent: "fix",
        preferredModel: "gpt-test",
        providers: [provider],
      }),
    ).rejects.toThrow("Refresh PR Hub");
    expect(harness.preparePullRequestThread).not.toHaveBeenCalled();
  });
});

it("offers review handoff after new commits, without a new review request", () => {
  const pr = makePr({
    attentionState: "changes_pushed",
    roles: ["involved"],
    checkRollup: "success",
  });
  expect(resolvePrF5RunKind(pr, undefined)).toBe("review");
  expect(prF5RunLabel("fix", makePr({ actionableUnresolvedThreadCount: 1 }))).toBe(
    "Address comments",
  );
});
it("includes verbatim review evidence and an honest bounded truncation notice", () => {
  const result: PrHubUnresolvedThreadsResult = {
    threads: [
      {
        id: "t",
        isResolved: false,
        path: "src/a.ts",
        line: 7,
        originalLine: null,
        comments: [
          {
            id: "c",
            url: "https://github.com",
            author: "alice",
            bodyText: "Verbatim feedback\nnext line",
            createdAt: null,
            updatedAt: null,
            outdated: true,
            diffHunk: null,
          },
        ],
      },
    ],
    truncated: true,
    omittedCount: 3,
    stale: false,
    refreshedAt: "2026-01-01T00:00:00Z",
  };
  const prompt = buildPrF5Prompt({ pr: makePr(), kind: "fix", reviewThreads: result });
  expect(prompt).toContain("src/a.ts:7");
  expect(prompt).toContain("[outdated] @alice: Verbatim feedback\nnext line");
  expect(prompt).toContain("3 further threads/comments not shown");
  const enormous = {
    ...result,
    threads: Array.from({ length: 30 }, () => ({
      ...result.threads[0]!,
      comments: [{ ...result.threads[0]!.comments[0]!, bodyText: "x".repeat(50_000) }],
    })),
  };
  const context = reviewThreadsContext(enormous);
  expect(context.length).toBeLessThanOrEqual(24_000);
  expect(context).toContain("read them on GitHub before concluding");
  expect(reviewThreadsContext(null)).toContain("could not load review threads");
});
