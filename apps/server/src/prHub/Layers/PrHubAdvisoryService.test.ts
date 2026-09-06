import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";

import { PullRequestKey, type PrHubSnapshot, type TrackedPullRequest } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PrHubAdvisoryService } from "../Services/PrHubAdvisoryService.ts";
import { PrHubService, type PrHubServiceShape } from "../Services/PrHubService.ts";
import {
  derivePrHubAdvisory,
  PrHubAdvisoryServiceLive,
  type PrHubAdvisoryFacts,
} from "./PrHubAdvisoryService.ts";

function makePr(input: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  const repo = input.repository?.nameWithOwner ?? "octo/repo";
  const number = input.number ?? 1;
  return {
    key: input.key ?? PullRequestKey.makeUnsafe(`github:github.com/${repo}#${number}`),
    provider: input.provider ?? "github",
    nodeId: input.nodeId ?? `PR_${number}`,
    number,
    title: input.title ?? `PR ${number}`,
    url: input.url ?? `https://github.com/${repo}/pull/${number}`,
    repository: input.repository ?? {
      owner: repo.split("/")[0] ?? "octo",
      repo: repo.split("/")[1] ?? "repo",
      nameWithOwner: repo,
    },
    host: input.host ?? "github.com",
    author: input.author ?? "me",
    isDraft: input.isDraft ?? false,
    state: input.state ?? "open",
    roles: input.roles ?? ["author"],
    attentionState: input.attentionState ?? "awaiting_review",
    attentionBucket: input.attentionBucket ?? "waiting_on_others",
    primaryReason: input.primaryReason ?? "Awaiting review",
    nextAction: input.nextAction ?? "Waiting on reviewers",
    checkRollup: input.checkRollup ?? "success",
    reviewDecision: input.reviewDecision ?? "review_required",
    mergeable: input.mergeable ?? "mergeable",
    mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
    viewerHasReviewed: input.viewerHasReviewed ?? false,
    viewerReviewRequested: input.viewerReviewRequested ?? false,
    reviewRequestReviewers: input.reviewRequestReviewers ?? ["alice"],
    reviewRequestsCount: input.reviewRequestsCount ?? 1,
    commentsCount: input.commentsCount ?? 0,
    unresolvedThreadCount: input.unresolvedThreadCount ?? 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: input.additions ?? 10,
    deletions: input.deletions ?? 2,
    changedFiles: input.changedFiles ?? 1,
    headRefOid: input.headRefOid ?? "head-1",
    baseRefName: input.baseRefName ?? "main",
    headRefName: input.headRefName ?? "feature",
    labels: input.labels ?? [],
    assignees: input.assignees ?? [],
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-02T00:00:00.000Z",
    snoozedUntil: input.snoozedUntil ?? null,
    ignoredAt: input.ignoredAt ?? null,
    notificationPending: input.notificationPending ?? false,
    attentionFingerprint: input.attentionFingerprint ?? `fingerprint-${number}`,
  };
}

function makeFacts(input: {
  readonly pr: TrackedPullRequest;
  readonly checkContexts?: PrHubAdvisoryFacts["checkContexts"];
  readonly reviewThreads?: PrHubAdvisoryFacts["reviewThreads"];
  readonly latestReviews?: PrHubAdvisoryFacts["latestReviews"];
}): PrHubAdvisoryFacts {
  return {
    pr: input.pr,
    viewerLogin: "me",
    bodyText: null,
    reviewThreads: input.reviewThreads ?? [],
    issueComments: [],
    latestReviews: input.latestReviews ?? [],
    checkContexts: input.checkContexts ?? [],
    truncated: false,
  };
}

function makeSnapshot(prs: ReadonlyArray<TrackedPullRequest>): PrHubSnapshot {
  return {
    status: "ok",
    account: { host: "github.com", viewerId: 1, login: "me", generation: "test-account" },
    viewerLogin: "me",
    host: "github.com",
    pullRequests: prs.filter((pr) => pr.state === "open" && pr.ignoredAt === null),
    recentlyResolved: prs.filter((pr) => pr.state !== "open" || pr.ignoredAt !== null),
    lastPolledAt: "2026-01-02T00:00:00.000Z",
  };
}

function makePrHubStub(snapshot: PrHubSnapshot): PrHubServiceShape {
  return {
    getSnapshot: Effect.succeed(snapshot),
    refreshNow: () => Effect.succeed(snapshot),
    streamChanges: Stream.empty,
    claimNotifications: () => Effect.die("unused"),
    startMonitoring: Effect.void,
    acknowledgeNotifications: () => Effect.die("unused"),
    getOverview: () => Effect.die("unused"),
    listPullRequests: () => Effect.die("unused"),
    approve: () => Effect.die("approve must not be called"),
    requestChanges: () => Effect.die("requestChanges must not be called"),
    comment: () => Effect.die("comment must not be called"),
    merge: () => Effect.die("merge must not be called"),
    markReady: () => Effect.die("markReady must not be called"),
    reRequestReview: () => Effect.die("reRequestReview must not be called"),
    snooze: () => Effect.succeed(snapshot),
    unsnooze: () => Effect.succeed(snapshot),
    ignore: () => Effect.succeed(snapshot),
    markSeen: () => Effect.succeed(snapshot),
    markNotified: () => Effect.succeed(snapshot),
    listLocalCheckoutCandidates: () => Effect.succeed([]),
    getDetail: () => Effect.die("getDetail must not be called"),
    getTimeline: () => Effect.die("getTimeline must not be called"),
    getUnresolvedThreads: () =>
      Effect.succeed({
        threads: [],
        truncated: false,
        omittedCount: 0,
        stale: false,
        refreshedAt: new Date().toISOString(),
      }),
    getFiles: () => Effect.die("getFiles must not be called"),
    prepareReview: () => Effect.die("prepareReview must not be called"),
    submitReview: () => Effect.die("submitReview must not be called"),
    getReviewOperation: () => Effect.die("getReviewOperation must not be called"),
    track: () => Effect.die("unused"),
    recoverReview: () => Effect.die("recoverReview must not be called"),
    cancelReviewPreparation: () => Effect.die("cancelReviewPreparation must not be called"),
    replyReviewThread: () => Effect.die("unused"),
    getReplyOperation: () => Effect.die("unused"),
    recoverReply: () => Effect.die("unused"),
    getReplyDraft: () => Effect.die("unused"),
    saveReplyDraft: () => Effect.die("unused"),
    getReviewThreads: () => Effect.die("unused"),
    setReviewThreadState: () => Effect.die("unused"),
    getReviewDraft: () => Effect.die("getReviewDraft must not be called"),
    saveReviewDraft: () => Effect.die("saveReviewDraft must not be called"),
    updateComment: () => Effect.die("updateComment must not be called"),
    setReaction: () => Effect.die("setReaction must not be called"),
    changeReviewers: () => Effect.die("changeReviewers must not be called"),
    updateBranch: () => Effect.die("updateBranch must not be called"),
    clearData: () => Effect.succeed(snapshot),
  };
}

function makeTextGenerationStub(overrides: Partial<TextGenerationShape> = {}): TextGenerationShape {
  return {
    generateCommitMessage: () => Effect.die("generateCommitMessage must not be called"),
    generatePrContent: () => Effect.die("generatePrContent must not be called"),
    generateBranchName: () => Effect.die("generateBranchName must not be called"),
    generateThreadTitle: () => Effect.die("generateThreadTitle must not be called"),
    generateStructuredJson: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generatePrHubAdvisory",
          detail: "model advisory not configured for this test",
        }),
      ),
    ...overrides,
  };
}

function makeGraphqlResponse(pr: TrackedPullRequest, extra: Record<string, unknown> = {}) {
  return {
    data: {
      node: {
        id: pr.nodeId,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: "OPEN",
        isDraft: pr.isDraft,
        bodyText: "",
        mergeable: pr.mergeable.toUpperCase(),
        reviewDecision: pr.reviewDecision.toUpperCase(),
        mergeStateStatus: pr.mergeStateStatus,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        baseRefName: pr.baseRefName,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        author: { login: pr.author },
        repository: { nameWithOwner: pr.repository.nameWithOwner },
        comments: { totalCount: 0, nodes: [] },
        reviewThreads: { totalCount: 0, nodes: [] },
        latestReviews: { nodes: [] },
        files: { totalCount: 0, nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: pr.headRefOid,
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: { nodes: [] },
                },
              },
            },
          ],
        },
        ...extra,
      },
    },
  };
}

function makeLayer(input: {
  readonly snapshot: PrHubSnapshot;
  readonly graphqlResponses?: ReadonlyArray<unknown>;
  readonly calls: {
    graphql: number;
    mutating: number;
  };
  readonly textGeneration?: TextGenerationShape;
}) {
  const responses = [...(input.graphqlResponses ?? [])];
  const github: GitHubCliShape = {
    request: () => Effect.die("Unexpected request"),
    getCredentialContext: () =>
      Effect.succeed({ host: "github.com", viewerId: 1, login: "me", generation: "test-account" }),
    execute: () => Effect.die("execute must not be called"),
    listOpenPullRequests: () => Effect.die("listOpenPullRequests must not be called"),
    getPullRequest: () => Effect.die("getPullRequest must not be called"),
    getRepositoryCloneUrls: () => Effect.die("getRepositoryCloneUrls must not be called"),
    createPullRequest: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    getDefaultBranch: () => Effect.die("getDefaultBranch must not be called"),
    checkoutPullRequest: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    getAuthenticatedLogin: () => Effect.succeed("me"),
    getViewerTeams: () => Effect.succeed([]),
    runGraphql: () =>
      Effect.sync(() => {
        input.calls.graphql += 1;
        return responses.shift() ?? makeGraphqlResponse(input.snapshot.pullRequests[0]!);
      }),
    searchPullRequests: () => Effect.die("searchPullRequests must not be called"),
    reviewPullRequest: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    requestChanges: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    commentPullRequest: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    mergePullRequest: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    markPullRequestReady: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    addPullRequestReviewers: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    changePullRequestReviewers: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    updatePullRequestBranch: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
    updatePullRequestComment: () =>
      Effect.sync(() => {
        input.calls.mutating += 1;
      }),
  };

  return PrHubAdvisoryServiceLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pr-advisory-test-" })),
    Layer.provideMerge(Layer.succeed(PrHubService, makePrHubStub(input.snapshot))),
    Layer.provideMerge(Layer.succeed(GitHubCli, github)),
    Layer.provideMerge(
      Layer.succeed(TextGeneration, input.textGeneration ?? makeTextGenerationStub()),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
}

it("derives baseline recommendations from high-priority PR signals", () => {
  assert.equal(
    derivePrHubAdvisory(makeFacts({ pr: makePr({ mergeable: "conflicting" }) })).recommendation,
    "resolve_conflicts",
  );
  assert.equal(
    derivePrHubAdvisory(makeFacts({ pr: makePr({ checkRollup: "failure" }) })).recommendation,
    "fix_ci",
  );
  assert.equal(
    derivePrHubAdvisory(makeFacts({ pr: makePr({ checkRollup: "pending" }) })).recommendation,
    "wait_for_ci",
  );
  assert.equal(
    derivePrHubAdvisory(makeFacts({ pr: makePr({ isDraft: true }) })).recommendation,
    "no_action",
  );
  assert.equal(
    derivePrHubAdvisory(
      makeFacts({
        pr: makePr({
          attentionState: "ready_to_merge",
          reviewDecision: "approved",
          checkRollup: "success",
          mergeable: "mergeable",
        }),
      }),
    ).recommendation,
    "ready_to_merge",
  );
});

it("maps unresolved review-thread comments into advisory findings", () => {
  const advisory = derivePrHubAdvisory(
    makeFacts({
      pr: makePr({
        reviewDecision: "changes_requested",
        unresolvedThreadCount: 1,
        actionableUnresolvedThreadCount: 0,
        waitingSince: null,
      }),
      latestReviews: [
        {
          id: "review-1",
          state: "CHANGES_REQUESTED",
          author: "alice",
          bodyText: "Please fix this.",
          submittedAt: "2026-01-02T00:00:00.000Z",
          url: "https://github.com/octo/repo/pull/1#pullrequestreview-1",
        },
      ],
      reviewThreads: [
        {
          id: "thread-1",
          isResolved: false,
          path: "src/file.ts",
          line: 10,
          originalLine: 10,
          comments: [
            {
              id: "comment-1",
              url: "https://github.com/octo/repo/pull/1#discussion_r1",
              author: "alice",
              bodyText: "This must handle null or it will crash.",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              outdated: false,
              diffHunk: null,
            },
          ],
        },
      ],
    }),
  );

  assert.equal(advisory.recommendation, "address_review_feedback");
  assert.equal(advisory.findings[0]?.validity, "valid");
  assert.match(advisory.findings[0]?.summary ?? "", /src\/file\.ts:10/);
});

it.effect("analyzes active PRs only by default and never calls mutating GitHub helpers", () => {
  const active = makePr({ number: 1 });
  const snoozed = makePr({
    number: 2,
    snoozedUntil: "2999-01-01T00:00:00.000Z",
  });
  const ignored = makePr({
    number: 3,
    ignoredAt: "2026-01-02T00:00:00.000Z",
  });
  const calls = { graphql: 0, mutating: 0 };

  return Effect.gen(function* () {
    const service = yield* PrHubAdvisoryService;
    const snapshot = yield* service.analyzeAdvisories({ mode: "stale_only" });

    assert.deepStrictEqual(
      snapshot.advisories.map((advisory) => advisory.key),
      [active.key],
    );
    assert.equal(calls.graphql, 1);
    assert.equal(calls.mutating, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        snapshot: makeSnapshot([active, snoozed, ignored]),
        graphqlResponses: [makeGraphqlResponse(active)],
        calls,
      }),
    ),
  );
});

it.effect("analyzes every active PR in a default batch", () => {
  const prs = Array.from({ length: 30 }, (_, index) => makePr({ number: index + 1 }));
  const calls = { graphql: 0, mutating: 0 };

  return Effect.gen(function* () {
    const service = yield* PrHubAdvisoryService;
    const snapshot = yield* service.analyzeAdvisories({ mode: "stale_only" });

    assert.equal(snapshot.advisories.length, prs.length);
    assert.equal(calls.graphql, prs.length);
    assert.equal(calls.mutating, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        snapshot: makeSnapshot(prs),
        graphqlResponses: prs.map((pr) => makeGraphqlResponse(pr)),
        calls,
      }),
    ),
  );
});

it.effect("uses the stronger default advisory model and maps model JSON onto real findings", () => {
  const pr = makePr({
    number: 31,
    unresolvedThreadCount: 1,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
  });
  const calls = { graphql: 0, mutating: 0 };
  const modelSelections: string[] = [];
  const textGeneration = makeTextGenerationStub({
    generateStructuredJson: ((input) => {
      const schemaDocument = Schema.toJsonSchemaDocument(input.outputSchema);
      const schema = schemaDocument.schema as {
        properties?: {
          findings?: {
            items?: {
              required?: ReadonlyArray<string>;
            };
          };
        };
      };
      assert.deepEqual(schema.properties?.findings?.items?.required, [
        "id",
        "validity",
        "summary",
        "rationale",
        "category",
      ]);
      modelSelections.push(
        `${input.modelSelection?.instanceId ?? "none"}:${input.modelSelection?.model ?? "none"}:${
          input.modelSelection?.options
            ?.map((option) => `${option.id}=${String(option.value)}`)
            .join(",") ?? ""
        }`,
      );
      return Effect.succeed({
        recommendation: "address_review_feedback",
        summary: "Address the concrete review blocker before asking for another pass.",
        confidence: 91,
        blockers: ["review feedback"],
        findings: [
          {
            id: "comment_model_1",
            validity: "valid",
            summary: "The null state handling needs a guard.",
            rationale: "The reviewer describes a concrete crash scenario.",
            category: "review_thread",
          },
          {
            id: "comment_hallucinated",
            validity: "valid",
            summary: "This should be dropped.",
            rationale: "The id is not present in GitHub facts.",
          },
        ],
      });
    }) as TextGenerationShape["generateStructuredJson"],
  });

  return Effect.gen(function* () {
    const service = yield* PrHubAdvisoryService;
    const snapshot = yield* service.analyzeAdvisories({ mode: "force" });
    const advisory = snapshot.advisories[0];

    assert.ok(advisory);
    assert.equal(
      advisory.summary,
      "Address the concrete review blocker before asking for another pass.",
    );
    assert.equal(advisory.confidence, 91);
    assert.equal(advisory.findings.length, 1);
    assert.equal(advisory.findings[0]?.id, "comment_model_1");
    assert.equal(advisory.findings[0]?.validity, "valid");
    assert.equal(modelSelections[0], "codex:gpt-5.6-sol:reasoningEffort=high");
  }).pipe(
    Effect.provide(
      makeLayer({
        snapshot: makeSnapshot([pr]),
        graphqlResponses: [
          makeGraphqlResponse(pr, {
            reviewThreads: {
              totalCount: 1,
              nodes: [
                {
                  id: "thread_model_1",
                  isResolved: false,
                  path: "src/file.ts",
                  line: 42,
                  originalLine: 42,
                  comments: {
                    totalCount: 1,
                    nodes: [
                      {
                        id: "comment_model_1",
                        bodyText: "This can crash when the state is null.",
                        url: "https://github.com/octo/repo/pull/31#discussion_r1",
                        author: { login: "reviewer" },
                        createdAt: "2026-01-02T00:00:00.000Z",
                        updatedAt: "2026-01-02T00:00:00.000Z",
                        outdated: false,
                        diffHunk: "@@ -1 +1 @@",
                      },
                    ],
                  },
                },
              ],
            },
          }),
        ],
        calls,
        textGeneration,
      }),
    ),
  );
});

it.effect("reuses unchanged advisory cache and recomputes in force mode", () => {
  const pr = makePr({ number: 4 });
  const calls = { graphql: 0, mutating: 0 };

  return Effect.gen(function* () {
    const service = yield* PrHubAdvisoryService;
    yield* service.analyzeAdvisories({ mode: "stale_only" });
    yield* service.analyzeAdvisories({ mode: "stale_only" });
    assert.equal(calls.graphql, 1);

    yield* service.analyzeAdvisories({ mode: "force" });
    assert.equal(calls.graphql, 2);
    assert.equal(calls.mutating, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        snapshot: makeSnapshot([pr]),
        graphqlResponses: [makeGraphqlResponse(pr), makeGraphqlResponse(pr)],
        calls,
      }),
    ),
  );
});
