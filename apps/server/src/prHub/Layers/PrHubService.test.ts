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
  readonly teams?: ReadonlyArray<string>;
  readonly teamsError?: GitHubCliError;
  readonly searchResponses?: unknown[];
  readonly detailResponses?: unknown[];
  readonly reconcileResponses?: unknown[];
  readonly reconcileByNumberResponses?: unknown[];
  readonly stallSearchAfterFirst?: boolean;
  readonly calls: HarnessCalls;
}): GitHubCliShape {
  const searchResponses = [...(input.searchResponses ?? [emptySearchResponse()])];
  const detailResponses = [...(input.detailResponses ?? [])];
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
      const response = request.query.includes("PrHubReconcileByNumber")
        ? nextResponse(reconcileByNumberResponses, reconcileByNumberResponse([]))
        : request.query.includes("PrHubReconcile")
          ? nextResponse(reconcileResponses, reconcileResponse([]))
          : request.query.includes("PrHubDetails")
            ? nextResponse(detailResponses, detailResponseFor(request))
            : nextResponse(searchResponses, emptySearchResponse());
      if (!isGitHubCliError(response) && request.query.includes("PrHubSearch")) {
        rememberDetailNodes(response);
      }
      return isGitHubCliError(response) ? Effect.fail(response) : Effect.succeed(response);
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
  };
}

function makeLayer(input: {
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly login?: string;
  readonly teams?: ReadonlyArray<string>;
  readonly teamsError?: GitHubCliError;
  readonly searchResponses?: unknown[];
  readonly detailResponses?: unknown[];
  readonly reconcileResponses?: unknown[];
  readonly reconcileByNumberResponses?: unknown[];
  readonly stallSearchAfterFirst?: boolean;
  readonly calls: HarnessCalls;
}) {
  const github = makeGithubStub(input);
  const gitCore = {
    readConfigValue: () => Effect.succeed(null),
  } as unknown as GitCoreShape;
  const projects = {
    upsert: () => Effect.void,
    getById: () => Effect.succeed(Option.none()),
    listAll: () => Effect.succeed([]),
    deleteById: () => Effect.void,
  } satisfies ProjectionProjectRepositoryShape;

  return PrHubServiceLive.pipe(
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
    approvals: [],
    changeRequests: [],
    comments: [],
    merges: [],
    markReady: [],
  };
}

function emptySearchData() {
  const data = {} as Record<SearchAlias, { issueCount: number; nodes: unknown[] }>;
  for (const alias of SEARCH_ALIASES) {
    data[alias] = { issueCount: 0, nodes: [] };
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
  data[alias] = { issueCount: nodes.length, nodes: [...nodes] };
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
    data[alias] = { issueCount: nodes.length, nodes: [...nodes] };
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
    repository: { nameWithOwner: repo, isPrivate: false },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 1 },
    reviewThreads: { nodes: [] },
    reviewRequests: {
      nodes: (input.reviewRequests ?? ["me"]).map((reviewer) => ({
        requestedReviewer: reviewer.includes("/")
          ? { combinedSlug: reviewer }
          : { login: reviewer },
      })),
    },
    latestReviews: { nodes: [] },
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

it.effect("requires three inaccessible misses before hiding a tracked PR", () => {
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
    assert.equal(thirdMiss.pullRequests.length, 0);
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
    assert.notEqual(rows[0]?.no_longer_relevant_at, null);
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

it.effect("clearData deletes PR Hub advisory rows", () => {
  const calls = makeCalls();
  const pr = makePrNode({ id: "PR_clear_advisory", number: 19 });

  return Effect.gen(function* () {
    const service = yield* PrHubService;
    const sql = yield* SqlClient.SqlClient;
    const snapshot = yield* service.refreshNow({ mode: "force" });
    const tracked = snapshot.pullRequests[0];
    assert.ok(tracked);

    yield* sql`
      INSERT INTO pr_hub_advisories (
        host,
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

    yield* service.clearData();

    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM pr_hub_advisories
    `;
    assert.equal(rows[0]?.count, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        calls,
        searchResponses: [searchResponse("review_requested", [pr])],
      }),
    ),
  );
});

it.effect("purges persisted rows for newly excluded repositories", () => {
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

    const second = yield* service.refreshNow({ mode: "force" });
    assert.deepStrictEqual(second.pullRequests, []);
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM pr_hub_prs
      WHERE repo = ${"octo/private"}
    `;
    assert.equal(rows[0]?.count, 0);
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
    } as Parameters<typeof service.merge>[0] & { readonly expectedHeadOid: string };
    yield* service.merge(staleClientInput);

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
