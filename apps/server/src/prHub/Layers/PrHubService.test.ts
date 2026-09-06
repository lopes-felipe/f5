import { PrHubJobCoordinatorLive } from "./PrHubJobCoordinator.ts";
import { PrHubDiscoveryLive } from "./PrHubDiscovery.ts";
import { PrHubReviewOperationsLive } from "./PrHubReviewOperations.ts";
import { claimPrHubNotifications, acknowledgePrHubNotifications } from "../notificationLeases.ts";
import type { GitHubCredentialContext } from "../../git/githubApi.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { GitHubCliError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PrHubService } from "../Services/PrHubService.ts";
import { PrHubServiceLive } from "./PrHubService.ts";

const SEARCH_ALIASES = [
  "review_requested",
  "team_review_0",
  "team_review_1",
  "team_review_2",
  "team_review_3",
  "team_review_4",
  "author",
  "assignee",
  "mentioned",
  "involved",
  "recently_closed",
] as const;

type SearchAlias = (typeof SEARCH_ALIASES)[number];

interface HarnessCalls {
  readonly graphql: Array<{
    readonly cwd: string;
    readonly query: string;
    readonly variables: Parameters<GitHubCliShape["runGraphql"]>[0]["variables"];
  }>;
  readonly addReviewers: Array<{
    readonly url: string;
    readonly reviewers: ReadonlyArray<string>;
  }>;
  readonly reviewerChanges: Array<{
    readonly url: string;
    readonly add: ReadonlyArray<string>;
    readonly remove: ReadonlyArray<string>;
  }>;
  readonly branchUpdates: Array<{
    readonly url: string;
    readonly method: "merge" | "rebase";
  }>;
  readonly commentUpdates: Array<{
    readonly repository: string;
    readonly commentId: string;
    readonly kind: "issue-comment" | "review-comment";
    readonly body: string;
  }>;
  readonly approvals: Array<{ readonly url: string; readonly body?: string | undefined }>;
  readonly changeRequests: Array<{ readonly url: string; readonly body: string }>;
  readonly comments: Array<{ readonly url: string; readonly body: string }>;
  readonly merges: Array<{
    readonly url: string;
    readonly method: "squash" | "merge" | "rebase";
    readonly expectedHeadOid?: string | undefined;
  }>;
  readonly markReady: Array<{ readonly url: string }>;
}

function ghError(detail: string) {
  return new GitHubCliError({
    operation: "prHub.test",
    detail,
    kind: "generic",
  });
}

function unsupportedGh<A>(operation: string): Effect.Effect<A, GitHubCliError> {
  return Effect.fail(
    new GitHubCliError({
      operation,
      detail: "not implemented in test stub",
      kind: "generic",
    }),
  );
}

function isGitHubCliError(value: unknown): value is GitHubCliError {
  return (value as { readonly _tag?: unknown } | null)?._tag === "GitHubCliError";
}

function makeGithubStub(input: {
  readonly login?: string;
  readonly apiRequest?: GitHubCliShape["request"];
  readonly credentialContext?: () => GitHubCredentialContext;
  readonly teams?: ReadonlyArray<string>;
  readonly teamsError?: GitHubCliError;
  readonly searchResponses?: unknown[];
  readonly detailResponses?: unknown[];
  readonly prDetailResponses?: unknown[];
  readonly timelineResponses?: unknown[];
  readonly fileResponses?: unknown[];
  readonly mutationResponses?: unknown[];
  readonly reconcileResponses?: unknown[];
  readonly reconcileByNumberResponses?: unknown[];
  readonly stallSearchAfterFirst?: boolean;
  readonly searchDelayMs?: number;
  readonly calls: HarnessCalls;
}): GitHubCliShape {
  const searchResponses = [...(input.searchResponses ?? [emptySearchResponse()])];
  const detailResponses = [...(input.detailResponses ?? [])];
  const prDetailResponses = [...(input.prDetailResponses ?? [])];
  const timelineResponses = [...(input.timelineResponses ?? [])];
  const fileResponses = [...(input.fileResponses ?? [])];
  const mutationResponses = [...(input.mutationResponses ?? [])];
  const reconcileResponses = [...(input.reconcileResponses ?? [])];
  const reconcileByNumberResponses = [...(input.reconcileByNumberResponses ?? [])];
  const detailNodesById = new Map<string, Record<string, unknown>>();
  let searchRequestCount = 0;
  const nextResponse = (responses: unknown[], fallback: unknown) =>
    responses.length > 0 ? responses.shift() : fallback;
  const rememberDetailNodes = (response: unknown) => {
    const data = (response as { readonly data?: unknown } | null)?.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
    for (const connection of Object.values(data)) {
      if (typeof connection !== "object" || connection === null || Array.isArray(connection)) {
        continue;
      }
      const nodes = (connection as { readonly nodes?: unknown }).nodes;
      if (!Array.isArray(nodes)) continue;
      for (const rawNode of nodes) {
        if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) continue;
        const node = rawNode as Record<string, unknown>;
        const id = node.id;
        if (typeof id === "string" && id.length > 0) detailNodesById.set(id, node);
      }
    }
  };
  const detailResponseFor = (request: Parameters<GitHubCliShape["runGraphql"]>[0]) => {
    const ids = Array.isArray(request.variables?.ids) ? request.variables.ids : [];
    return {
      data: {
        nodes: ids.map((id) => detailNodesById.get(String(id)) ?? null),
      },
    };
  };

  return {
    request: (request) =>
      input.apiRequest
        ? input.apiRequest(request)
        : Effect.succeed({
            status: 200,
            graphqlErrors: [],
            links: {},
            etag: null,
            lastModified: null,
            rateLimit: { remaining: 100, limit: 5000, resetAt: null },
            rateLimitResource: "core",
            body: request.endpoint.endsWith("/files")
              ? nextResponse(fileResponses, [])
              : request.endpoint.includes("/compare/")
                ? { merge_base_commit: { sha: "base" } }
                : {
                    base: { ref: "main", sha: "base", repo: { full_name: "octo/repo" } },
                    head: { ref: "feature", sha: "head", repo: { full_name: "octo/repo" } },
                    changed_files: 1,
                  },
          }),
    getCredentialContext: () =>
      Effect.succeed(
        input.credentialContext?.() ?? {
          host: "github.com",
          viewerId: input.login === "other-viewer" ? 2 : 1,
          login: input.login ?? "me",
          generation: input.login ?? "test-account",
        },
      ),
    execute: () => unsupportedGh("execute"),
    listOpenPullRequests: () => unsupportedGh("listOpenPullRequests"),
    getPullRequest: () => unsupportedGh("getPullRequest"),
    getRepositoryCloneUrls: () => unsupportedGh("getRepositoryCloneUrls"),
    createPullRequest: () => unsupportedGh("createPullRequest"),
    getDefaultBranch: () => unsupportedGh("getDefaultBranch"),
    checkoutPullRequest: () => unsupportedGh("checkoutPullRequest"),
    getAuthenticatedLogin: () => Effect.succeed(input.login ?? "me"),
    getViewerTeams: () =>
      input.teamsError ? Effect.fail(input.teamsError) : Effect.succeed(input.teams ?? []),
    runGraphql: (request) => {
      input.calls.graphql.push({
        cwd: request.cwd,
        query: request.query,
        variables: request.variables,
      });
      if (request.query.includes("PrHubSearch")) {
        searchRequestCount += 1;
        if (input.stallSearchAfterFirst && searchRequestCount > 1) {
          return Effect.never;
        }
      }
      const response = request.query.includes("PrHubRepositories")
        ? {
            data: {
              viewer: {
                repositories: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          }
        : request.query.includes("F5PrDetail(") || request.query.includes("PrHubReviewThreads(")
          ? nextResponse(prDetailResponses, emptySearchResponse())
          : request.query.includes("F5PrTimeline(")
            ? nextResponse(timelineResponses, emptySearchResponse())
            : request.query.includes("F5PrFiles(")
              ? nextResponse(fileResponses, emptySearchResponse())
              : request.query.includes("mutation F5")
                ? nextResponse(mutationResponses, { data: {} })
                : request.query.includes("PrHubReconcileByNumber")
                  ? nextResponse(reconcileByNumberResponses, reconcileByNumberResponse([]))
                  : request.query.includes("PrHubReconcile")
                    ? nextResponse(reconcileResponses, reconcileResponse([]))
                    : request.query.includes("PrHubDetails")
                      ? nextResponse(detailResponses, detailResponseFor(request))
                      : nextResponse(searchResponses, emptySearchResponse());
      if (!isGitHubCliError(response) && request.query.includes("PrHubSearch")) {
        rememberDetailNodes(response);
      }
      const responseEffect = isGitHubCliError(response)
        ? Effect.fail(response)
        : Effect.succeed(response);
      return request.query.includes("PrHubSearch") && (input.searchDelayMs ?? 0) > 0
        ? Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, input.searchDelayMs!)),
          ).pipe(Effect.andThen(responseEffect))
        : responseEffect;
    },
    searchPullRequests: () => Effect.succeed([]),
    reviewPullRequest: (request) =>
      Effect.sync(() => {
        input.calls.approvals.push({ url: request.url, body: request.body });
      }),
    requestChanges: (request) =>
      Effect.sync(() => {
        input.calls.changeRequests.push({ url: request.url, body: request.body });
      }),
    commentPullRequest: (request) => {
      return Effect.sync(() => {
        input.calls.comments.push({ url: request.url, body: request.body });
      });
    },
    mergePullRequest: (request) => {
      return Effect.sync(() => {
        input.calls.merges.push({
          url: request.url,
          method: request.method,
          expectedHeadOid: request.expectedHeadOid,
        });
      });
    },
    markPullRequestReady: (request) =>
      Effect.sync(() => {
        input.calls.markReady.push({ url: request.url });
      }),
    addPullRequestReviewers: (request) => {
      return Effect.sync(() => {
        input.calls.addReviewers.push({ url: request.url, reviewers: request.reviewers });
      });
    },
    changePullRequestReviewers: (request) =>
      Effect.sync(() => {
        input.calls.reviewerChanges.push({
          url: request.url,
          add: request.add,
          remove: request.remove,
        });
      }),
    updatePullRequestBranch: (request) =>
      Effect.sync(() => {
        input.calls.branchUpdates.push({ url: request.url, method: request.method });
      }),
    updatePullRequestComment: (request) =>
      Effect.sync(() => {
        input.calls.commentUpdates.push({
          repository: request.repository,
          commentId: request.commentId,
          kind: request.kind,
          body: request.body,
        });
      }),
  };
}

function makeLayer(input: {
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly login?: string;
  readonly apiRequest?: GitHubCliShape["request"];
  readonly credentialContext?: () => GitHubCredentialContext;
  readonly teams?: ReadonlyArray<string>;
  readonly teamsError?: GitHubCliError;
  readonly searchResponses?: unknown[];
  readonly detailResponses?: unknown[];
  readonly prDetailResponses?: unknown[];
  readonly timelineResponses?: unknown[];
  readonly fileResponses?: unknown[];
  readonly mutationResponses?: unknown[];
  readonly reconcileResponses?: unknown[];
  readonly reconcileByNumberResponses?: unknown[];
  readonly stallSearchAfterFirst?: boolean;
  readonly searchDelayMs?: number;
  readonly calls: HarnessCalls;
}) {
  const github = makeGithubStub(input);
  const gitCore = {
    readConfigValue: () => Effect.succeed(null),
    listRemotes: () => Effect.succeed([]),
  } as unknown as GitCoreShape;
  const projects = {
    upsert: () => Effect.void,
    getById: () => Effect.succeed(Option.none()),
    listAll: () => Effect.succeed([]),
    deleteById: () => Effect.void,
  } satisfies ProjectionProjectRepositoryShape;

  return PrHubServiceLive.pipe(
    Layer.provide(PrHubReviewOperationsLive),
    Layer.provide(PrHubDiscoveryLive),
    Layer.provide(PrHubJobCoordinatorLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pr-hub-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest(input.settings ?? {})),
    Layer.provideMerge(Layer.succeed(GitHubCli, github)),
    Layer.provideMerge(Layer.succeed(GitCore, gitCore)),
    Layer.provideMerge(Layer.succeed(ProjectionProjectRepository, projects)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeCalls(): HarnessCalls {
  return {
    graphql: [],
    addReviewers: [],
    reviewerChanges: [],
    branchUpdates: [],
    commentUpdates: [],
    approvals: [],
    changeRequests: [],
    comments: [],
    merges: [],
    markReady: [],
  };
}

function emptySearchData() {
  const data = {} as Record<
    SearchAlias,
    {
      issueCount: number;
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }
  >;
  for (const alias of SEARCH_ALIASES) {
    data[alias] = { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }
  return data;
}

function emptySearchResponse(extra?: Record<string, unknown>) {
  return {
    data: emptySearchData(),
    ...extra,
  };
}

function searchResponse(
  alias: SearchAlias,
  nodes: ReadonlyArray<unknown>,
  extra?: Record<string, unknown>,
) {
  const data = emptySearchData();
  data[alias] = {
    issueCount: nodes.length,
    nodes: [...nodes],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  return {
    data,
    ...extra,
  };
}

function multiSearchResponse(entries: Partial<Record<SearchAlias, ReadonlyArray<unknown>>>) {
  const data = emptySearchData();
  for (const [alias, nodes] of Object.entries(entries) as Array<
    readonly [SearchAlias, ReadonlyArray<unknown>]
  >) {
    data[alias] = {
      issueCount: nodes.length,
      nodes: [...nodes],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }
  return { data };
}

function cappedSearchResponse(
  alias: SearchAlias,
  nodes: ReadonlyArray<unknown>,
  issueCount: number,
) {
  const response = searchResponse(alias, nodes);
  response.data[alias].issueCount = issueCount;
  return response;
}

function reconcileResponse(nodes: ReadonlyArray<unknown>) {
  return {
    data: {
      nodes: [...nodes],
    },
  };
}

function reconcileByNumberResponse(nodes: ReadonlyArray<unknown>) {
  return {
    data: Object.fromEntries(nodes.map((node, index) => [`pr${index}`, { pullRequest: node }])),
  };
}

function recentResolvedAtIso() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function makePrNode(input: {
  readonly id?: string;
  readonly number?: number;
  readonly repo?: string;
  readonly author?: string;
  readonly title?: string;
  readonly url?: string;
  readonly updatedAt?: string;
  readonly isDraft?: boolean;
  readonly reviewDecision?: string;
  readonly mergeable?: string;
  readonly mergeStateStatus?: string;
  readonly checkState?: string;
  readonly headRefOid?: string | null;
  readonly reviewRequests?: ReadonlyArray<string>;
}) {
  const number = input.number ?? 1;
  const repo = input.repo ?? "octo/repo";
  return {
    id: input.id ?? `PR_${number}`,
    number,
    title: input.title ?? `PR ${number}`,
    url: input.url ?? `https://github.com/${repo}/pull/${number}`,
    state: "OPEN",
    isDraft: input.isDraft ?? false,
    mergeable: input.mergeable ?? "UNKNOWN",
    reviewDecision: input.reviewDecision ?? "REVIEW_REQUIRED",
    mergeStateStatus: input.mergeStateStatus ?? "UNKNOWN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-02T00:00:00.000Z",
    closedAt: null,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    headRefOid: input.headRefOid === undefined ? `head-${number}` : input.headRefOid,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    author: { login: input.author ?? "teammate" },
    repository: { nameWithOwner: repo, isPrivate: false, viewerPermission: "WRITE" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 1 },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewRequests: {
      nodes: (input.reviewRequests ?? ["me"]).map((reviewer) => ({
        requestedReviewer: reviewer.includes("/")
          ? { combinedSlug: reviewer }
          : { login: reviewer },
      })),
    },
    latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: { state: input.checkState ?? "SUCCESS" },
          },
        },
      ],
    },
  };
}

function prDetailResponse(input: { readonly title?: string } = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_detail",
          title: input.title ?? "Detailed PR",
          body: "Detailed body",
          url: "https://github.com/octo/repo/pull/30",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          additions: 10,
          deletions: 2,
          changedFiles: 3,
          headRefName: "feature-30",
          baseRefName: "main",
          headRefOid: "head-30",
          baseRefOid: "base-30",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          mergedAt: null,
          closedAt: null,
          viewerCanUpdate: true,
          viewerDidAuthor: true,
          author: { login: "me" },
          labels: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [], pageInfo: { hasNextPage: false } },
          reactionGroups: [],
          commits: { nodes: [] },
        },
      },
      rateLimit: { remaining: 100, limit: 5_000, resetAt: null },
    },
  };
}

function prTimelineResponse(input?: {
  readonly issueComments?: ReadonlyArray<Record<string, unknown>>;
}) {
  return {
    data: {
      repository: {
        pullRequest: {
          comments: {
            nodes: input?.issueComments ?? [],
            pageInfo: { hasPreviousPage: false, startCursor: null },
          },
          reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
          commits: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
        },
      },
      rateLimit: { remaining: 100, limit: 5_000, resetAt: null },
    },
  };
}

function prFilesResponse() {
  return [
    {
      filename: "src/a.ts",
      additions: 2,
      deletions: 1,
      status: "modified",
      sha: "blob",
      patch: "@@ -1 +1,2 @@\n-old\n+new\n+line",
    },
  ];
}

it.effect("coalesces overlapping forced refreshes into one GitHub fetch", () => {
  const calls = makeCalls();
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    yield* Effect.all(
      Array.from({ length: 4 }, () => service.refreshNow({ mode: "force" })),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );

    const searchCalls = calls.graphql.filter((call) => call.query.includes("PrHubSearch"));
    assert.equal(searchCalls.length, 1);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchDelayMs: 50,
        searchResponses: [emptySearchResponse()],
      }),
    ),
  );
});

it.effect("marks partial GraphQL responses degraded without hiding previously tracked PRs", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_partial", number: 10 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const first = yield* service.refreshNow({ mode: "force" });
    assert.equal(first.status, "ok");
    assert.deepStrictEqual(
      first.pullRequests.map((tracked) => tracked.number),
      [10],
    );

    const second = yield* service.refreshNow({ mode: "force" });
    assert.equal(second.status, "degraded");
    assert.deepStrictEqual(
      second.pullRequests.map((tracked) => tracked.number),
      [10],
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("review_requested", [pr]),
          emptySearchResponse({ errors: [{ message: "rate limited" }] }),
        ],
      }),
    ),
  );
});

it.effect("stores a concise degraded message when GraphQL falls back to gh search", () => {
  const calls = makeCalls();

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });

    assert.equal(snapshot.status, "degraded");
    assert.equal(
      snapshot.errorMessage,
      "GitHub API returned HTTP 502. Showing fallback search results.",
    );
    assert.equal(snapshot.errorMessage?.includes("query PrHub"), false);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [ghError("GitHub API returned HTTP 502.")],
      }),
    ),
  );
});

it.effect("keeps bucket search lightweight and hydrates PR details separately", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_lightweight", number: 99 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });

    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.pullRequests[0]?.number, 99);
    const searchCall = calls.graphql[0];
    const detailCall = calls.graphql.find((call) => call.query.includes("PrHubDetails"));
    assert.ok(searchCall);
    assert.match(searchCall.query, /PrHubSearch/);
    assert.equal(searchCall.query.includes("reviewThreads"), false);
    assert.equal(searchCall.query.includes("latestReviews"), false);
    assert.ok(detailCall);
    assert.match(detailCall.query, /reviewThreads/);
    assert.deepStrictEqual(detailCall.variables?.ids, ["PR_lightweight"]);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr])],
      }),
    ),
  );
});

it.effect("sorts search buckets by latest update", () => {
  const calls = makeCalls();

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    yield* service.refreshNow({ mode: "force" });

    const variables = calls.graphql[0]?.variables as Record<string, string> | undefined;
    assert.ok(variables);
    const expectSorted = (value: string | undefined) => {
      if (typeof value !== "string") throw new Error("Expected search query variable.");
      assert.match(value, /sort:updated-desc/);
    };
    expectSorted(variables.rr);
    expectSorted(variables.au);
    expectSorted(variables.closed);
    expectSorted(variables.tr0);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [emptySearchResponse()],
      }),
    ),
  );
});

it.effect("splits failing GraphQL detail chunks before degrading", () => {
  const calls = makeCalls();
  const prs = Array.from({ length: 12 }, (_, index) =>
    makePrNode({ id: `PR_split_${index + 1}`, number: index + 1 }),
  );

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });

    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.pullRequests.length, 12);
    assert.equal(snapshot.errorMessage, undefined);

    const detailChunkSizes = calls.graphql
      .filter((call) => call.query.includes("PrHubDetails"))
      .map((call) => (Array.isArray(call.variables?.ids) ? call.variables.ids.length : 0));
    assert.deepStrictEqual(detailChunkSizes, [8, 4, 4, 4]);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", prs)],
        detailResponses: [ghError("GitHub API returned HTTP 502.")],
      }),
    ),
  );
});

it.effect("stores a concise degraded message when GraphQL details cannot be hydrated", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_detail_502", number: 100 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });

    assert.equal(snapshot.status, "degraded");
    assert.equal(
      snapshot.errorMessage,
      "GitHub API returned HTTP 502. Showing fallback search results.",
    );
    assert.equal(snapshot.errorMessage?.includes("query PrHub"), false);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr])],
        detailResponses: [ghError("GitHub API returned HTTP 502.")],
      }),
    ),
  );
});

it.effect("transitions missing node-id PRs to recently resolved", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_resolved", number: 11 });
  const resolvedAt = recentResolvedAtIso();

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    yield* service.refreshNow({ mode: "force" });

    const snapshot = yield* service.refreshNow({ mode: "force" });
    assert.deepStrictEqual(snapshot.pullRequests, []);
    assert.equal(snapshot.recentlyResolved.length, 1);
    assert.equal(snapshot.recentlyResolved[0]?.state, "merged");
    assert.equal(snapshot.recentlyResolved[0]?.attentionState, "merged");
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr]), emptySearchResponse()],
        reconcileResponses: [
          reconcileResponse([
            {
              id: "PR_resolved",
              state: "MERGED",
              closedAt: resolvedAt,
              mergedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          ]),
        ],
      }),
    ),
  );
});

it.effect("terminal-reconciles capped missing PRs by node id", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_capped_resolved", number: 16 });
  const resolvedAt = recentResolvedAtIso();

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    yield* service.refreshNow({ mode: "force" });

    const snapshot = yield* service.refreshNow({ mode: "force" });
    assert.deepStrictEqual(snapshot.pullRequests, []);
    assert.equal(snapshot.recentlyResolved.length, 1);
    assert.equal(snapshot.recentlyResolved[0]?.state, "closed");
    assert.deepStrictEqual(snapshot.cappedBuckets, ["recently_closed"]);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("review_requested", [pr]),
          cappedSearchResponse("recently_closed", [], 99),
        ],
        reconcileResponses: [
          reconcileResponse([
            {
              id: "PR_capped_resolved",
              state: "CLOSED",
              closedAt: resolvedAt,
              mergedAt: null,
              updatedAt: resolvedAt,
            },
          ]),
        ],
      }),
    ),
  );
});

it.effect("terminal-reconciles capped fallback rows by repository and number", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_number_resolved", number: 17 });
  const resolvedAt = recentResolvedAtIso();

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.refreshNow({ mode: "force" });
    yield* sql`
      UPDATE pr_hub_prs
      SET node_id = NULL
      WHERE repo = ${"octo/repo"}
        AND number = ${17}
    `;

    const snapshot = yield* service.refreshNow({ mode: "force" });
    assert.deepStrictEqual(snapshot.pullRequests, []);
    assert.equal(snapshot.recentlyResolved.length, 1);
    assert.equal(snapshot.recentlyResolved[0]?.nodeId, "PR_number_resolved");
    assert.equal(snapshot.recentlyResolved[0]?.state, "merged");
    assert.equal(
      calls.graphql.some((call) => call.query.includes("PrHubReconcileByNumber")),
      true,
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("review_requested", [pr]),
          cappedSearchResponse("recently_closed", [], 99),
        ],
        reconcileByNumberResponses: [
          reconcileByNumberResponse([
            {
              id: "PR_number_resolved",
              state: "MERGED",
              closedAt: resolvedAt,
              mergedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          ]),
        ],
      }),
    ),
  );
});

it.effect("does not count capped omissions as inaccessible misses", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_capped_open", number: 18 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.refreshNow({ mode: "force" });

    const snapshot = yield* service.refreshNow({ mode: "force" });
    assert.equal(snapshot.pullRequests.length, 1);
    const rows = yield* sql<{
      readonly stale_inaccessible_count: number;
      readonly no_longer_relevant_at: string | null;
    }>`
      SELECT stale_inaccessible_count, no_longer_relevant_at
      FROM pr_hub_viewer_state
      WHERE viewer_login = ${"me"}
        AND repo = ${"octo/repo"}
        AND number = ${18}
    `;
    assert.equal(rows[0]?.stale_inaccessible_count, 0);
    assert.equal(rows[0]?.no_longer_relevant_at, null);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("review_requested", [pr]),
          cappedSearchResponse("review_requested", [], 99),
        ],
        reconcileResponses: [
          reconcileResponse([
            {
              id: "PR_capped_open",
              state: "OPEN",
              closedAt: null,
              mergedAt: null,
              updatedAt: "2026-06-23T00:00:00.000Z",
            },
          ]),
        ],
      }),
    ),
  );
});

it.effect("retains tracked PRs after repeated inaccessible search misses", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_inaccessible", number: 12 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;

    yield* service.refreshNow({ mode: "force" });
    const firstMiss = yield* service.refreshNow({ mode: "force" });
    const secondMiss = yield* service.refreshNow({ mode: "force" });
    const thirdMiss = yield* service.refreshNow({ mode: "force" });

    assert.equal(firstMiss.pullRequests.length, 1);
    assert.equal(secondMiss.pullRequests.length, 1);
    assert.equal(thirdMiss.pullRequests.length, 1);
    const rows = yield* sql<{
      readonly stale_inaccessible_count: number;
      readonly no_longer_relevant_at: string | null;
    }>`
      SELECT stale_inaccessible_count, no_longer_relevant_at
      FROM pr_hub_viewer_state
      WHERE viewer_login = ${"me"}
        AND repo = ${"octo/repo"}
        AND number = ${12}
    `;
    assert.equal(rows[0]?.stale_inaccessible_count, 3);
    assert.equal(rows[0]?.no_longer_relevant_at, null);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("review_requested", [pr]),
          emptySearchResponse(),
          emptySearchResponse(),
          emptySearchResponse(),
        ],
        reconcileResponses: [
          reconcileResponse([null]),
          reconcileResponse([null]),
          reconcileResponse([null]),
        ],
      }),
    ),
  );
});

it.effect("scopes mark-seen and snooze updates to the active viewer", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_viewer_scope", number: 13 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    yield* sql`
      INSERT INTO pr_hub_viewer_state (
        host,
        viewer_id,
        viewer_login,
        repo,
        number,
        roles_json,
        attention_state,
        attention_bucket,
        primary_reason,
        next_action,
        sort_timestamp,
        attention_fingerprint,
        last_seen_fingerprint,
        last_notified_fingerprint,
        last_notified_at,
        snoozed_until,
        last_matched_at,
        no_longer_relevant_at,
        stale_inaccessible_count,
        stale_inaccessible_at
      )
      SELECT
        host,
        ${"2"},
        ${"other-viewer"},
        repo,
        number,
        roles_json,
        attention_state,
        attention_bucket,
        primary_reason,
        next_action,
        sort_timestamp,
        attention_fingerprint,
        NULL,
        NULL,
        NULL,
        NULL,
        last_matched_at,
        NULL,
        0,
        NULL
      FROM pr_hub_viewer_state
      WHERE viewer_login = ${"me"}
        AND repo = ${"octo/repo"}
        AND number = ${13}
    `;

    const snoozedUntil = "2026-02-01T00:00:00.000Z";
    yield* service.markSeen({
      key: tracked.key,
      attentionFingerprint: tracked.attentionFingerprint,
    });
    yield* service.snooze({ key: tracked.key, until: snoozedUntil });

    const rows = yield* sql<{
      readonly viewer_login: string;
      readonly last_seen_fingerprint: string | null;
      readonly snoozed_until: string | null;
    }>`
      SELECT viewer_login, last_seen_fingerprint, snoozed_until
      FROM pr_hub_viewer_state
      WHERE repo = ${"octo/repo"}
        AND number = ${13}
      ORDER BY viewer_login
    `;
    const byViewer = new Map(rows.map((row) => [row.viewer_login, row]));
    assert.equal(byViewer.get("me")?.last_seen_fingerprint, tracked.attentionFingerprint);
    assert.equal(byViewer.get("me")?.snoozed_until, snoozedUntil);
    assert.equal(byViewer.get("other-viewer")?.last_seen_fingerprint, null);
    assert.equal(byViewer.get("other-viewer")?.snoozed_until, null);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr])],
      }),
    ),
  );
});

it.effect("moves ignored pull requests to resolved history for the active viewer", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_ignore", number: 14 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    yield* sql`
      INSERT INTO pr_hub_viewer_state (
        host,
        viewer_id,
        viewer_login,
        repo,
        number,
        roles_json,
        attention_state,
        attention_bucket,
        primary_reason,
        next_action,
        sort_timestamp,
        attention_fingerprint,
        last_seen_fingerprint,
        last_notified_fingerprint,
        last_notified_at,
        snoozed_until,
        last_matched_at,
        no_longer_relevant_at,
        stale_inaccessible_count,
        stale_inaccessible_at
      )
      SELECT
        host,
        ${"2"},
        ${"other-viewer"},
        repo,
        number,
        roles_json,
        attention_state,
        attention_bucket,
        primary_reason,
        next_action,
        sort_timestamp,
        attention_fingerprint,
        NULL,
        NULL,
        NULL,
        NULL,
        last_matched_at,
        NULL,
        0,
        NULL
      FROM pr_hub_viewer_state
      WHERE viewer_login = ${"me"}
        AND repo = ${"octo/repo"}
        AND number = ${14}
    `;

    const ignored = yield* service.ignore({ key: tracked.key });

    assert.deepStrictEqual(
      ignored.pullRequests.map((entry) => entry.key),
      [],
    );
    assert.equal(ignored.recentlyResolved[0]?.key, tracked.key);
    assert.ok(ignored.recentlyResolved[0]?.ignoredAt);
    assert.equal(ignored.recentlyResolved[0]?.notificationPending, false);

    const rows = yield* sql<{
      readonly viewer_login: string;
      readonly ignored_at: string | null;
    }>`
      SELECT viewer_login, ignored_at
      FROM pr_hub_viewer_state
      WHERE repo = ${"octo/repo"}
        AND number = ${14}
      ORDER BY viewer_login
    `;
    const byViewer = new Map(rows.map((row) => [row.viewer_login, row]));
    assert.ok(byViewer.get("me")?.ignored_at);
    assert.equal(byViewer.get("other-viewer")?.ignored_at, null);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr])],
      }),
    ),
  );
});

it.effect("clearData isolates the selected account and rejects an old generation", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_clear_advisory", number: 19 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    for (const viewerId of ["1", "2"])
      yield* sql`
      INSERT INTO pr_hub_advisories (
        host,
        viewer_id,
        viewer_login,
        repo,
        number,
        key,
        fingerprint,
        status,
        recommendation,
        summary,
        confidence,
        blockers_json,
        findings_json,
        degraded,
        truncated,
        generated_at,
        error_kind,
        error_message,
        payload_json,
        updated_at
      )
      VALUES (
        ${tracked.host},
        ${viewerId},
        ${"me"},
        ${tracked.repository.nameWithOwner},
        ${tracked.number},
        ${tracked.key},
        ${"fingerprint"},
        ${"succeeded"},
        ${"no_action"},
        ${"summary"},
        ${50},
        ${"[]"},
        ${"[]"},
        ${0},
        ${0},
        ${"2026-01-02T00:00:00.000Z"},
        ${null},
        ${null},
        ${"{}"},
        ${"2026-01-02T00:00:00.000Z"}
      )
    `;

    assert.equal(
      (yield* Effect.exit(service.clearData({ accountGeneration: "old-account" })))._tag,
      "Failure",
    );
    yield* service.clearData();

    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM pr_hub_advisories
    `;
    assert.equal(rows[0]?.count, 1);
    const remaining = yield* sql<{ viewer_id: string }>`SELECT viewer_id FROM pr_hub_advisories`;
    assert.equal(remaining[0]?.viewer_id, "2");
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr])],
      }),
    ),
  );
});

it.effect("hides excluded repositories while retaining shared facts and preferences", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_excluded", number: 14, repo: "octo/private" });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const settings = yield* ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;

    const first = yield* service.refreshNow({ mode: "force" });
    assert.equal(first.pullRequests.length, 1);
    yield* settings.updateSettings({
      prHub: { excludeRepos: ["octo/private"] },
    });

    const excluded = yield* service.getSnapshot;
    assert.equal(excluded.pullRequests.length, 0);
    assert.notEqual(excluded.revision, first.revision);
    assert.equal(Exit.isFailure(yield* Effect.exit(service.approve({ url: pr.url }))), true);
    assert.equal(calls.approvals.length, 0);
    const second = yield* service.refreshNow({ mode: "force" });
    assert.deepStrictEqual(second.pullRequests, []);
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM pr_hub_prs
      WHERE repo = ${"octo/private"}
    `;
    assert.equal(rows[0]?.count, 1);
    const viewerRows = yield* sql<{ readonly no_longer_relevant_at: string | null }>`
      SELECT no_longer_relevant_at FROM pr_hub_viewer_state WHERE repo = ${"octo/private"}
    `;
    assert.equal(viewerRows.length, 1);
    assert.equal(viewerRows[0]?.no_longer_relevant_at, null);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("review_requested", [pr]),
          searchResponse("review_requested", [pr]),
        ],
      }),
    ),
  );
});

it.effect("chunks team review queries and marks team lookup failures degraded", () => {
  const calls = makeCalls();
  const teams = Array.from({ length: 12 }, (_, index) => `wolt/team-${index}`);

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    assert.equal(snapshot.status, "ok");

    const variables = calls.graphql[0]?.variables as Record<string, string> | undefined;
    assert.ok(variables);
    const { tr0, tr1 } = variables;
    if (typeof tr0 !== "string" || typeof tr1 !== "string") {
      throw new Error("Expected team review query variables to be strings");
    }
    assert.match(tr0, /team-review-requested:wolt\/team-0/);
    assert.match(tr0, /team-review-requested:wolt\/team-9/);
    assert.equal(/team-review-requested:wolt\/team-10/.test(tr0), false);
    assert.match(tr1, /team-review-requested:wolt\/team-10/);
    assert.match(tr1, /team-review-requested:wolt\/team-11/);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        teams,
        searchResponses: [emptySearchResponse()],
      }),
    ),
  );
});

it.effect("surfaces degraded status when viewer teams cannot be resolved", () => {
  const calls = makeCalls();

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    assert.equal(snapshot.status, "degraded");
    assert.match(snapshot.errorMessage ?? "", /team review requests may be incomplete/i);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        teamsError: ghError("missing read:org"),
        searchResponses: [emptySearchResponse()],
      }),
    ),
  );
});

it.effect("enforces tracked-state predicates before mutating PRs", () => {
  const calls = makeCalls();
  const reviewRequestedPr = makePrNode({
    id: "PR_review_requested",
    number: 22,
    author: "teammate",
    reviewRequests: ["me"],
  });
  const authorDraftPr = makePrNode({
    id: "PR_author_draft",
    number: 23,
    author: "me",
    isDraft: true,
  });
  const authorWaitingPr = makePrNode({
    id: "PR_author_waiting",
    number: 24,
    author: "me",
    reviewDecision: "REVIEW_REQUIRED",
  });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const byNumber = new Map(snapshot.pullRequests.map((pr) => [pr.number, pr]));
    const reviewRequested = byNumber.get(22);
    const authorDraft = byNumber.get(23);
    const authorWaiting = byNumber.get(24);
    assert.ok(reviewRequested);
    assert.ok(authorDraft);
    assert.ok(authorWaiting);
    assert.equal(reviewRequested.attentionState, "review_requested");
    assert.equal(authorDraft.attentionState, "draft");
    assert.equal(authorWaiting.attentionState, "awaiting_review");

    yield* service.approve({ url: reviewRequested.url, body: "looks good" });
    yield* service.requestChanges({ url: reviewRequested.url, body: "please fix" });
    yield* service.markReady({ url: authorDraft.url });

    assert.deepStrictEqual(calls.approvals, [{ url: reviewRequested.url, body: "looks good" }]);
    assert.deepStrictEqual(calls.changeRequests, [
      { url: reviewRequested.url, body: "please fix" },
    ]);
    assert.deepStrictEqual(calls.markReady, [{ url: authorDraft.url }]);

    const deniedApprove = yield* Effect.exit(service.approve({ url: authorWaiting.url }));
    const deniedRequestChanges = yield* Effect.exit(
      service.requestChanges({ url: authorWaiting.url, body: "nope" }),
    );
    const deniedMarkReady = yield* Effect.exit(service.markReady({ url: authorWaiting.url }));

    assert.equal(Exit.isFailure(deniedApprove), true);
    assert.equal(Exit.isFailure(deniedRequestChanges), true);
    assert.equal(Exit.isFailure(deniedMarkReady), true);
    assert.equal(calls.approvals.length, 1);
    assert.equal(calls.changeRequests.length, 1);
    assert.equal(calls.markReady.length, 1);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          multiSearchResponse({
            review_requested: [reviewRequestedPr],
            author: [authorDraftPr, authorWaitingPr],
          }),
          multiSearchResponse({
            review_requested: [reviewRequestedPr],
            author: [authorDraftPr, authorWaitingPr],
          }),
          multiSearchResponse({
            review_requested: [reviewRequestedPr],
            author: [authorDraftPr, authorWaitingPr],
          }),
          multiSearchResponse({
            review_requested: [reviewRequestedPr],
            author: [authorDraftPr, authorWaitingPr],
          }),
        ],
      }),
    ),
  );
});

it.effect("returns a successful review action without waiting for post-action refresh", () => {
  const calls = makeCalls();
  const reviewRequestedPr = makePrNode({
    id: "PR_review_refresh_timeout",
    number: 25,
    author: "teammate",
    reviewRequests: ["me"],
  });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const reviewRequested = snapshot.pullRequests.find((pr) => pr.number === 25);
    assert.ok(reviewRequested);

    const result = yield* service
      .approve({ url: reviewRequested.url, body: "looks good" })
      .pipe(Effect.timeoutOption(100));

    assert.equal(Option.isSome(result), true);
    assert.deepStrictEqual(calls.approvals, [{ url: reviewRequested.url, body: "looks good" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          multiSearchResponse({
            review_requested: [reviewRequestedPr],
          }),
        ],
        stallSearchAfterFirst: true,
      }),
    ),
  );
});

it.effect("guards mutating actions and defaults re-request reviewers from tracked state", () => {
  const calls = makeCalls();
  const authorPr = makePrNode({
    id: "PR_rerequest",
    number: 15,
    author: "me",
    reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: ["alice", "wolt/platform"],
  });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);
    assert.equal(tracked.attentionState, "awaiting_review");

    const untrackedExit = yield* Effect.exit(
      service.comment({
        url: "https://github.com/octo/repo/pull/999",
        body: "not tracked",
      }),
    );
    assert.equal(Exit.isFailure(untrackedExit), true);
    assert.equal(calls.comments.length, 0);

    yield* service.reRequestReview({ url: tracked.url });
    assert.deepStrictEqual(calls.addReviewers, [
      {
        url: tracked.url,
        reviewers: ["alice", "wolt/platform"],
      },
    ]);

    const invalidReviewerExit = yield* Effect.exit(
      service.reRequestReview({ url: tracked.url, reviewers: ["bad;name"] }),
    );
    assert.equal(Exit.isFailure(invalidReviewerExit), true);
    assert.equal(calls.addReviewers.length, 1);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [
          searchResponse("author", [authorPr]),
          searchResponse("author", [authorPr]),
        ],
      }),
    ),
  );
});

it.effect("uses the tracked head oid for merge instead of trusting client input", () => {
  const calls = makeCalls();
  const readyPr = makePrNode({
    id: "PR_merge",
    number: 20,
    author: "me",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checkState: "SUCCESS",
    headRefOid: "tracked-head",
  });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);
    assert.equal(tracked.attentionState, "ready_to_merge");

    const staleClientInput = {
      url: tracked.url,
      method: "squash",
      expectedHeadOid: "stale-client-head",
      expectedComparison: {
        baseRepository: "octo/repo",
        baseRef: "main",
        baseOid: "base",
        headRepository: "octo/repo",
        headRef: "feature",
        headOid: "tracked-head",
        mergeBaseOid: "base",
        mode: "current_pr",
      },
    } as Parameters<typeof service.merge>[0] & { readonly expectedHeadOid: string };
    yield* service.merge(staleClientInput);
    assert.equal(
      (yield* Effect.exit(
        service.merge({
          ...staleClientInput,
          expectedComparison: { ...staleClientInput.expectedComparison!, baseOid: "old-base" },
        }),
      ))._tag,
      "Failure",
    );

    assert.deepStrictEqual(calls.merges, [
      {
        url: tracked.url,
        method: "squash",
        expectedHeadOid: "tracked-head",
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        apiRequest: (input) =>
          Effect.succeed({
            status: 200,
            graphqlErrors: [],
            links: {},
            etag: null,
            lastModified: null,
            rateLimit: {},
            rateLimitResource: "core",
            body: input.endpoint.endsWith("/files")
              ? []
              : input.endpoint.includes("/compare/")
                ? { merge_base_commit: { sha: "base" } }
                : {
                    base: { ref: "main", sha: "base", repo: { full_name: "octo/repo" } },
                    head: { ref: "feature", sha: "tracked-head", repo: { full_name: "octo/repo" } },
                    changed_files: 1,
                  },
          }),
        searchResponses: [searchResponse("author", [readyPr]), searchResponse("author", [readyPr])],
      }),
    ),
  );
});

it.effect("refuses merge when the tracked head oid is missing", () => {
  const calls = makeCalls();
  const readyPr = makePrNode({
    id: "PR_merge_missing_head",
    number: 21,
    author: "me",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checkState: "SUCCESS",
    headRefOid: null,
  });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);
    assert.equal(tracked.attentionState, "ready_to_merge");

    const exit = yield* Effect.exit(service.merge({ url: tracked.url, method: "squash" }));

    assert.equal(Exit.isFailure(exit), true);
    assert.deepStrictEqual(calls.merges, []);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("author", [readyPr])],
      }),
    ),
  );
});

it.effect("loads GitHub detail surfaces and retains cached data on transient failures", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_detail", number: 30, author: "me" });
  const transientFailure = new GitHubCliError({
    operation: "graphql",
    detail: "The network is temporarily unavailable.",
    kind: "network",
  });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    const detail = yield* service.getDetail({ key: tracked.key });
    const timeline = yield* service.getTimeline({ key: tracked.key });
    const files = yield* service.getFiles({ key: tracked.key });
    assert.equal(detail.detail.title, "Fresh detail");
    assert.deepStrictEqual(timeline.entries, []);
    assert.equal(files.files[0]?.path, "src/a.ts");

    const stale = yield* service.getDetail({ key: tracked.key, mode: "force" });
    assert.equal(stale.detail.title, "Fresh detail");
    assert.equal(stale.stale, true);
    assert.equal(stale.warning, "The network is temporarily unavailable.");
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("author", [pr])],
        prDetailResponses: [prDetailResponse({ title: "Fresh detail" }), transientFailure],
        timelineResponses: [prTimelineResponse()],
        fileResponses: [prFilesResponse()],
      }),
    ),
  );
});

it.effect("reconciles detail mutations and forwards provider-native arguments", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_detail", number: 30, author: "me" });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    const commentResult = yield* service.updateComment({
      key: tracked.key,
      commentId: "123",
      kind: "issue-comment",
      body: "Updated body",
    });
    assert.equal(commentResult.detail.detail.title, "After comment");

    const reactionResult = yield* service.setReaction({
      key: tracked.key,
      subjectId: "PR_detail",
      content: "eyes",
      reacted: true,
    });
    assert.equal(reactionResult.detail.detail.title, "After reaction");

    const reviewerResult = yield* service.changeReviewers({
      key: tracked.key,
      add: ["alice"],
      remove: ["bob"],
    });
    assert.equal(reviewerResult.detail.detail.title, "After reviewers");

    const branchResult = yield* service.updateBranch({ key: tracked.key, method: "rebase" });
    assert.equal(branchResult.detail.detail.title, "After branch");

    assert.deepStrictEqual(calls.commentUpdates, [
      {
        repository: "octo/repo",
        commentId: "123",
        kind: "issue-comment",
        body: "Updated body",
      },
    ]);
    assert.deepStrictEqual(calls.reviewerChanges, [
      { url: tracked.url, add: ["alice"], remove: ["bob"] },
    ]);
    assert.deepStrictEqual(calls.branchUpdates, [{ url: tracked.url, method: "rebase" }]);
    assert.ok(calls.graphql.some((call) => call.query.includes("mutation F5AddReaction")));
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("author", [pr])],
        stallSearchAfterFirst: true,
        prDetailResponses: [
          prDetailResponse({ title: "After comment" }),
          prDetailResponse({ title: "Before reaction" }),
          prDetailResponse({ title: "After reaction" }),
          prDetailResponse({ title: "After reviewers" }),
          prDetailResponse({ title: "After branch" }),
        ],
        timelineResponses: [
          prTimelineResponse({
            issueComments: [
              {
                id: "IC_1",
                databaseId: 123,
                body: "Original body",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: null,
                url: "https://github.com/octo/repo/pull/30#issuecomment-123",
                viewerDidAuthor: true,
                author: { login: "me" },
                reactionGroups: [],
              },
            ],
          }),
          prTimelineResponse(),
          prTimelineResponse(),
          prTimelineResponse(),
          prTimelineResponse(),
        ],
        mutationResponses: [{ data: { addReaction: { subject: { id: "IC_1" } } } }],
      }),
    ),
  );
});

it.effect("rejects reaction mutations that return GraphQL errors", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_detail", number: 30, author: "me" });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    const exit = yield* Effect.exit(
      service.setReaction({
        key: tracked.key,
        subjectId: "PR_detail",
        content: "eyes",
        reacted: true,
      }),
    );

    assert.equal(Exit.isFailure(exit), true);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("author", [pr])],
        stallSearchAfterFirst: true,
        prDetailResponses: [prDetailResponse({ title: "Before reaction" })],
        mutationResponses: [
          { data: { addReaction: null }, errors: [{ message: "Reaction denied" }] },
        ],
      }),
    ),
  );
});

it.effect("rejects comment and reaction object ids that are not bound to the tracked PR", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_detail", number: 30, author: "me" });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    const commentExit = yield* Effect.exit(
      service.updateComment({
        key: tracked.key,
        commentId: "999",
        kind: "issue-comment",
        body: "Unauthorized update",
      }),
    );
    const reactionExit = yield* Effect.exit(
      service.setReaction({
        key: tracked.key,
        subjectId: "IC_unrelated",
        content: "eyes",
        reacted: true,
      }),
    );

    assert.equal(Exit.isFailure(commentExit), true);
    assert.equal(Exit.isFailure(reactionExit), true);
    assert.deepStrictEqual(calls.commentUpdates, []);
    assert.equal(
      calls.graphql.some((call) => call.query.includes("mutation F5")),
      false,
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("author", [pr])],
        stallSearchAfterFirst: true,
        prDetailResponses: [prDetailResponse()],
        timelineResponses: [prTimelineResponse(), prTimelineResponse()],
      }),
    ),
  );
});

it.effect("uses reviewed commit identity even when pushed commits have old timestamps", () => {
  const calls = makeCalls();
  const node = {
    ...makePrNode({ number: 501, reviewRequests: [], headRefOid: "new-head" }),
    latestReviews: {
      nodes: [{ author: { login: "me" }, state: "COMMENTED", commit: { oid: "old-head" } }],
    },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2025-01-01T00:00:00.000Z",
            statusCheckRollup: { state: "SUCCESS" },
          },
        },
      ],
    },
  };
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const pr = snapshot.pullRequests[0]!;
    assert.equal(pr.attentionState, "changes_pushed");
    assert.equal(pr.viewerReviewRequested, false);
    assert.equal(pr.waitingSince, "2025-01-01T00:00:00.000Z");
    yield* service.approve({ url: pr.url });
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("involved", [node]), searchResponse("involved", [node])],
      }),
    ),
  );
});

it.effect(
  "persists actionable feedback, excludes author replies and avoids count-change notifications",
  () => {
    const calls = makeCalls();
    const thread = (author: string, isOutdated = false, isResolved = false) => ({
      isResolved,
      isOutdated,
      comments: { nodes: [{ author: { login: author } }] },
    });
    const node = (count: number) => ({
      ...makePrNode({ number: 502, author: "me", reviewRequests: ["alice"] }),
      reviewThreads: {
        nodes: [
          ...Array.from({ length: count }, () => thread("alice")),
          thread("ME"),
          thread("alice", true),
          thread("alice", false, true),
        ],
      },
    });
    return Effect.gen(function* () {
      const service = yield* PrHubService;
      const sql = yield* SqlClient.SqlClient;
      const baseline = yield* service.refreshNow({ mode: "force" });
      assert.equal(baseline.pullRequests[0]!.notificationPending, false);
      const first = (yield* service.refreshNow({ mode: "force" })).pullRequests[0]!;
      assert.equal(first.attentionState, "unresolved_comments");
      assert.equal(first.actionableUnresolvedThreadCount, 5);
      assert.equal(first.notificationPending, true);
      yield* service.markSeen({ key: first.key, attentionFingerprint: first.attentionFingerprint });
      const second = (yield* service.refreshNow({ mode: "force" })).pullRequests[0]!;
      assert.equal(second.actionableUnresolvedThreadCount, 4);
      assert.equal(second.attentionFingerprint, first.attentionFingerprint);
      assert.equal(second.notificationPending, false);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT viewer_payload_json AS payload_json FROM pr_hub_viewer_state WHERE number = 502`;
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.waitingSince, first.createdAt);
      assert.equal(payload.actionableUnresolvedThreadCount, 4);
      yield* service.reRequestReview({ url: first.url });
      let replied = (yield* service.getSnapshot).pullRequests[0]!;
      // Mutations enqueue reconciliation; wait for the published result rather than
      // relying on the refresh fiber winning the race with the next local read.
      for (
        let attempt = 0;
        attempt < 100 && replied.attentionState !== "awaiting_review";
        attempt++
      ) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
        replied = (yield* service.getSnapshot).pullRequests[0]!;
      }
      assert.equal(replied.attentionState, "awaiting_review");
      assert.equal(replied.actionableUnresolvedThreadCount, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          calls,
          searchResponses: [
            searchResponse("author", [node(0)]),
            searchResponse("author", [node(5)]),
            searchResponse("author", [node(4)]),
            searchResponse("author", [node(0)]),
          ],
        }),
      ),
    );
  },
);

it.effect("rebaselines upgraded fingerprints without suppressing already pending attention", () => {
  const calls = makeCalls();
  const node = makePrNode({ number: 503 });
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.refreshNow({ mode: "force" });
    yield* sql`UPDATE pr_hub_viewer_state SET attention_model_version = 1, attention_bucket = 'waiting_on_others', attention_fingerprint = 'legacy'`;
    const upgraded = (yield* service.refreshNow({ mode: "force" })).pullRequests[0]!;
    assert.equal(upgraded.notificationPending, false);
    yield* sql`UPDATE pr_hub_viewer_state SET attention_model_version = 1, attention_bucket = 'needs_you', attention_fingerprint = 'legacy', last_seen_fingerprint = NULL, last_notified_fingerprint = NULL`;
    const pending = (yield* service.refreshNow({ mode: "force" })).pullRequests[0]!;
    assert.equal(pending.notificationPending, true);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: Array.from({ length: 3 }, () =>
          searchResponse("review_requested", [node]),
        ),
      }),
    ),
  );
});

it.effect("loads verbatim threads through the shared detail cache with honest coverage", () => {
  const calls = makeCalls();
  const node = makePrNode({ number: 504 });
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const pr = (yield* service.refreshNow({ mode: "force" })).pullRequests[0]!;
    const first = yield* service.getUnresolvedThreads({ key: pr.key });
    assert.equal(first.truncated, true);
    assert.equal(first.omittedCount, 1);
    assert.equal(first.threads[0]?.comments[0]?.bodyText, "Please handle this race.");
    const cached = yield* service.getUnresolvedThreads({ key: pr.key });
    assert.deepStrictEqual(cached, first);
    assert.equal(
      calls.graphql.filter((call) => call.query.includes("PrHubReviewThreads(")).length,
      1,
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [node])],
        prDetailResponses: [
          {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    totalCount: 2,
                    nodes: [
                      {
                        id: "thread",
                        isResolved: false,
                        path: "src/a.ts",
                        line: 5,
                        comments: {
                          totalCount: 1,
                          nodes: [
                            {
                              id: "c",
                              bodyText: "Please handle this race.",
                              author: { login: "alice" },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      }),
    ),
  );
});

it.effect("rejects a write after an account switch even if the display login is unchanged", () => {
  const calls = makeCalls();
  let context: GitHubCredentialContext = {
    host: "github.com",
    viewerId: 1,
    login: "me",
    generation: "first",
  };
  const pr = makePrNode({ number: 505 });
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const first = yield* service.refreshNow({ mode: "force" });
    assert.equal(first.account?.viewerId, 1);
    context = { ...context, viewerId: 2, generation: "second" };
    const result = yield* Effect.exit(service.approve({ url: pr.url }));
    assert.equal(Exit.isFailure(result), true);
    assert.equal(calls.approvals.length, 0);
    const changed = yield* service.getSnapshot;
    assert.equal(changed.account?.viewerId, 2);
    assert.equal(changed.pullRequests.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        credentialContext: () => context,
        searchResponses: [searchResponse("review_requested", [pr])],
      }),
    ),
  );
});

it.effect("keeps viewer facts out of the shared provider payload", () => {
  const calls = makeCalls();
  const pr = makePrNode({ number: 506 });
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.refreshNow({ mode: "force" });
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM pr_hub_prs WHERE number = 506`;
    const payload = JSON.parse(rows[0]!.payload_json);
    assert.equal("viewerHasReviewed" in payload, false);
    assert.equal("viewerReviewRequested" in payload, false);
    assert.equal("waitingSince" in payload, false);
    const viewer = yield* sql<{
      viewer_id: string;
      viewer_payload_json: string;
    }>`SELECT viewer_id, viewer_payload_json FROM pr_hub_viewer_state WHERE number = 506`;
    assert.equal(viewer[0]?.viewer_id, "1");
    assert.equal(JSON.parse(viewer[0]!.viewer_payload_json).viewerReviewRequested, true);
  }).pipe(
    Effect.provide(
      makeLayer({ calls, searchResponses: [searchResponse("review_requested", [pr])] }),
    ),
  );
});

it.effect("leases notifications across clients and acknowledges only captured versions", () => {
  const calls = makeCalls();
  const pr = makePrNode({ number: 600 });
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    const baseline = yield* service.refreshNow({ mode: "force" });
    assert.equal(baseline.pullRequests[0]!.notificationPending, false);
    const snapshot = {
      ...baseline,
      pullRequests: baseline.pullRequests.map((pr) => ({ ...pr, notificationPending: true })),
    };
    yield* sql`UPDATE pr_hub_viewer_state SET last_seen_fingerprint = NULL`;
    const accountGeneration = snapshot.account!.generation;
    const now = Date.now();
    const first = yield* claimPrHubNotifications(
      snapshot,
      { accountGeneration, clientId: "one", maxItems: 20 },
      now,
    );
    assert.equal(first.pullRequests.length, 1);
    const other = yield* claimPrHubNotifications(
      snapshot,
      { accountGeneration, clientId: "two", maxItems: 20 },
      now,
    );
    assert.equal(other.pullRequests.length, 0);
    yield* sql`UPDATE pr_hub_viewer_state SET attention_fingerprint = 'newer'`;
    yield* acknowledgePrHubNotifications(
      snapshot,
      { accountGeneration, clientId: "one", batchId: first.batchId },
      now + 1,
    );
    const rows = yield* sql<{
      last_notified_fingerprint: string;
    }>`SELECT last_notified_fingerprint FROM pr_hub_viewer_state`;
    assert.equal(rows[0]!.last_notified_fingerprint, first.pullRequests[0]!.attentionFingerprint);
    const newerSnapshot = {
      ...snapshot,
      pullRequests: snapshot.pullRequests.map((pr) => ({ ...pr, attentionFingerprint: "newer" })),
    };
    const newer = yield* claimPrHubNotifications(
      newerSnapshot,
      { accountGeneration, clientId: "two", maxItems: 20 },
      now + 2,
    );
    assert.equal(newer.pullRequests.length, 1);
    const expired = yield* claimPrHubNotifications(
      newerSnapshot,
      { accountGeneration, clientId: "three", maxItems: 20 },
      now + 30_003,
    );
    assert.equal(expired.pullRequests.length, 1);
    yield* acknowledgePrHubNotifications(
      newerSnapshot,
      { accountGeneration, clientId: "two", batchId: newer.batchId },
      now + 30_004,
    );
    const lease = yield* sql<{
      notification_lease_owner: string;
    }>`SELECT notification_lease_owner FROM pr_hub_viewer_state`;
    assert.equal(lease[0]!.notification_lease_owner, "three");
  }).pipe(
    Effect.provide(
      makeLayer({ calls, searchResponses: [searchResponse("review_requested", [pr])] }),
    ),
  );
});

it.effect(
  "validates live comparisons and submits the frozen review through the account-bound API",
  () => {
    const calls = makeCalls();
    const pr = makePrNode({ id: "PR_submission", number: 90, author: "alice" });
    let head = "head";
    let remoteBody = "";
    let writes = 0;
    const apiRequest: GitHubCliShape["request"] = (request) => {
      let body: unknown;
      if (request.method === "POST") {
        writes++;
        remoteBody = String((request.body as Record<string, unknown>).body);
        body = {
          id: 123,
          user: { id: 1 },
          body: remoteBody,
          state: request.endpoint.endsWith("/events") ? "APPROVED" : "PENDING",
          commit_id: "head",
        };
        if (request.endpoint.endsWith("/events")) head = "racing-head";
      } else if (request.endpoint.endsWith("/123")) {
        body = { id: 123, user: { id: 1 }, body: remoteBody, state: "PENDING", commit_id: "head" };
      } else if (request.endpoint.includes("/compare/"))
        body = { merge_base_commit: { sha: "base" } };
      else if (/\/(files|reviews|comments)$/.test(request.endpoint)) body = [];
      else
        body = {
          state: "open",
          locked: false,
          user: { id: 2 },
          changed_files: 0,
          base: { ref: "main", sha: "base", repo: { full_name: "octo/repo" } },
          head: { ref: "feature", sha: head, repo: { full_name: "octo/repo" } },
        };
      return Effect.succeed({
        status: 200,
        body,
        graphqlErrors: [],
        links: {},
        etag: null,
        lastModified: null,
        rateLimit: { remaining: 100, limit: 5000, resetAt: null },
        rateLimitResource: "core",
      });
    };
    return Effect.gen(function* () {
      const service = yield* PrHubService;
      const snapshot = yield* service.refreshNow({ mode: "force" });
      const key = snapshot.pullRequests[0]!.key;
      const files = yield* service.getFiles({ key });
      yield* service.saveReviewDraft({
        key,
        expectedVersion: 0,
        comparison: files.comparison!,
        content: { body: "Looks good", comments: [], viewedFiles: [] },
      });
      yield* service.prepareReview({ key, id: "first", expectedVersion: 1, event: "APPROVE" });
      head = "new-head";
      assert.equal(
        (yield* Effect.exit(service.submitReview({ key, id: "first" })))._tag,
        "Failure",
      );
      assert.equal(writes, 0);
      yield* service.cancelReviewPreparation({ key, id: "first" });
      head = "head";
      const prepared = yield* service.prepareReview({
        key,
        id: "second",
        expectedVersion: 1,
        event: "APPROVE",
      });
      assert.equal(prepared.status, "prepared");
      const submitted = yield* service.submitReview({ key, id: "second" });
      assert.equal(submitted.status, "succeeded");
      assert.equal(submitted.comparisonStatus, "outdated");
      assert.equal(submitted.payload.draft.comparison.headOid, "head");
      assert.equal(writes, 2);
      assert.equal((yield* service.getReviewDraft({ key })).draft?.content.body, "");
    }).pipe(
      Effect.provide(
        makeLayer({
          calls,
          apiRequest,
          searchResponses: [searchResponse("review_requested", [pr])],
        }),
      ),
    );
  },
);

it.effect("manually tracks a verified PR and applies exclusions before any remote read", () => {
  const calls = makeCalls();
  const node = makePrNode({ number: 777, author: "someone", reviewRequests: [] });
  let reads = 0;
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    yield* service.refreshNow({ mode: "force" });
    const pr = yield* service.track({ url: "https://github.com/octo/repo/pull/777/files" });
    assert.equal(pr.manuallyTracked, true);
    assert.equal(pr.attentionState, "mentioned");
    assert.equal((yield* service.getSnapshot).pullRequests[0]?.manuallyTracked, true);
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({ prHub: { excludeRepos: ["octo/repo"] } });
    assert.equal((yield* Effect.exit(service.track({ url: pr.url })))._tag, "Failure");
    assert.equal(reads, 1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      payload: string;
    }>`SELECT viewer_payload_json AS payload FROM pr_hub_viewer_state WHERE number = 777`;
    assert.equal(JSON.parse(rows[0]!.payload).manuallyTracked, true);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        detailResponses: [{ data: { nodes: [node] } }],
        apiRequest: (input) => {
          reads++;
          assert.equal(input.endpoint, "repos/octo/repo/pulls/777");
          return Effect.succeed({
            status: 200,
            body: { node_id: "PR_777" },
            graphqlErrors: [],
            links: {},
            etag: null,
            lastModified: null,
            rateLimitResource: "core",
            rateLimit: { remaining: 100 },
          });
        },
      }),
    ),
  );
});

it.effect("keeps archived tracked PRs visible but blocks publishing actions", () => {
  const calls = makeCalls();
  const original = makePrNode({ number: 991 });
  const node = { ...original, repository: { ...original.repository, isArchived: true } };
  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const pr = snapshot.pullRequests[0]!;
    assert.equal(pr.repositoryArchived, true);
    assert.equal(pr.attentionBucket, "informational");
    assert.equal(pr.reasons?.[0]?.code, "repository_archived");
    assert.equal(pr.notificationPending, false);
    assert.equal((yield* Effect.exit(service.approve({ url: pr.url })))._tag, "Failure");
    assert.equal(calls.approvals.length, 0);
    assert.equal((yield* service.getSnapshot).pullRequests[0]?.repositoryArchived, true);
  }).pipe(
    Effect.provide(
      makeLayer({ calls, searchResponses: [searchResponse("review_requested", [node])] }),
    ),
  );
});
