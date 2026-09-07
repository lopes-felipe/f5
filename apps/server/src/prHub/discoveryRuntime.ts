import { isBranchRulePage, readMergeRequirements } from "./mergeRequirements.ts";

import { continuePrConnectionPagination } from "./attentionPagination.ts";

import { PR_HUB_MERGE_STATE_QUERY, recheckUnknownMergeStates } from "./mergeState.ts";

import type { SearchTask } from "./discovery.ts";

import { GitHubRequestPriority } from "../git/githubRequestScheduler.ts";

import { defaultPrHubCoverage } from "./readModel.ts";

import { mapGitHubCliError } from "../sourceControl/GitHubSourceControlProvider.ts";

import { type PrHubLocalCheckoutCandidate, type PrHubSnapshot } from "@t3tools/contracts";

import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  FetchResult,
  NO_MATCH_SEARCH_QUERY,
  NormalizedPr,
  PR_HUB_DETAILS_CHUNK_SIZE,
  PR_HUB_DETAILS_QUERY,
  PR_HUB_RECONCILE_QUERY,
  PR_HUB_SEARCH_QUERY,
  PersistedPrRow,
  RECONCILE_NODE_CHUNK_SIZE,
  RECONCILE_REPO_NUMBER_CHUNK_SIZE,
  ReconciledPrState,
  TEAM_QUERY_CHUNK_COUNT,
  TEAM_QUERY_CHUNK_SIZE,
  ViewerIdentity,
  asArray,
  asRecord,
  buildReconcileByNumberRequest,
  buildSearchQueries,
  causeUserMessage,
  nodeArray,
  normalizeFallbackPr,
  normalizeGraphqlPr,
  normalizeTerminalPullRequestState,
  numberValue,
  shouldSplitDetailChunk,
  stringValue,
} from "./discoveryModel.ts";

import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import type { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import type { PrHubDiscoveryMethods } from "./Services/PrHubDiscovery.ts";
export interface PrHubDiscoveryContext {
  readonly host: string;
  readonly cwd: string;
  readonly settings: ServerSettingsShape;
  readonly githubCli: GitHubCliShape;
  readonly github: SourceControlProvider;
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly getProjectRepositoryCandidates: () => Effect.Effect<PrHubLocalCheckoutCandidate[]>;
}
export function createPrHubDiscovery(
  context: PrHubDiscoveryContext & { sql: SqlClient.SqlClient; discovery: PrHubDiscoveryMethods },
) {
  const {
    host,
    cwd,
    settings,
    githubCli,
    github,
    getSnapshot,
    getProjectRepositoryCandidates,
    sql,
  } = context;
  const providerKind = "github";
  const {
    ingestPrHubSearch,
    enqueuePrHubTracked,
    beginPrHubSearch,
    resumePrHubSearch,
    selectPrHubHydration,
    syncPrHubRepositories,
    discoverNotificationSubjects,
  } = context.discovery;
  const fetchGraphqlDetails = (
    nodeIds: ReadonlyArray<string>,
    priorities?: ReadonlyMap<string, { priority?: number }>,
  ): Effect.Effect<
    {
      readonly nodesById: ReadonlyMap<string, Record<string, unknown>>;
      readonly degraded: boolean;
      readonly errorMessage?: string | undefined;
    },
    never
  > =>
    Effect.gen(function* () {
      const nodesById = new Map<string, Record<string, unknown>>();
      let degraded = false;
      let errorMessage: string | undefined;
      let loggedFailureCount = 0;

      const hydrateChunk = (ids: ReadonlyArray<string>): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          if (ids.length === 0) return;
          const result = yield* Effect.exit(
            github.query({
              cwd,
              document: PR_HUB_DETAILS_QUERY,
              variables: { ids },
            }),
          );
          if (Exit.isFailure(result)) {
            const message = causeUserMessage(
              result.cause,
              "GitHub GraphQL PR detail request failed.",
            );
            if (ids.length > 1 && shouldSplitDetailChunk(result.cause)) {
              const mid = Math.ceil(ids.length / 2);
              yield* hydrateChunk(ids.slice(0, mid));
              yield* hydrateChunk(ids.slice(mid));
              return;
            }

            degraded = true;
            errorMessage ??= message;
            loggedFailureCount += 1;
            if (loggedFailureCount <= 5) {
              yield* Effect.logWarning("PR Hub GraphQL detail chunk failed", {
                detail: message,
                chunkSize: ids.length,
              });
            } else if (loggedFailureCount === 6) {
              yield* Effect.logWarning("PR Hub GraphQL detail chunk failed", {
                detail: `${message} Additional detail chunk failures suppressed.`,
                chunkSize: ids.length,
              });
            }
            return;
          }

          const response = asRecord(result.value);
          const graphQlErrors = asArray(response?.errors);
          if (graphQlErrors.length > 0) {
            degraded = true;
            errorMessage ??= `GitHub GraphQL returned partial PR detail errors for ${graphQlErrors.length} chunk(s).`;
          }
          const nodes = asArray(asRecord(response?.data)?.nodes);
          for (const rawNode of nodes) {
            const node = asRecord(rawNode);
            const nodeId = node ? stringValue(node.id) : null;
            if (!node || !nodeId) continue;
            nodesById.set(nodeId, node);
          }
        });

      for (let index = 0; index < nodeIds.length; index += PR_HUB_DETAILS_CHUNK_SIZE) {
        const ids = nodeIds.slice(index, index + PR_HUB_DETAILS_CHUNK_SIZE);
        if (ids.length === 0) continue;
        const rank = Math.max(...ids.map((id) => priorities?.get(id)?.priority ?? 0));
        yield* hydrateChunk(ids).pipe(
          Effect.provideService(
            GitHubRequestPriority,
            rank >= 2 ? "attention" : rank === 1 ? "changed" : "cold",
          ),
        );
      }

      const candidates = [...nodesById.values()].flatMap((node) => {
        const id = stringValue(node.id);
        const headRefOid = stringValue(node.headRefOid);
        const baseRefOid = stringValue(node.baseRefOid);
        return id &&
          headRefOid &&
          baseRefOid &&
          node.state === "OPEN" &&
          node.isDraft !== true &&
          node.reviewDecision === "APPROVED" &&
          (node.mergeable === "UNKNOWN" || node.mergeStateStatus === "UNKNOWN")
          ? [{ id, headRefOid, baseRefOid }]
          : [];
      });
      const calculated = yield* recheckUnknownMergeStates(candidates, (ids) =>
        Effect.gen(function* () {
          const current = yield* settings.getSettings.pipe(Effect.orDie);
          const excluded = new Set(
            current.prHub.excludeRepos.map((repo) => repo.trim().toLowerCase()),
          );
          const allowed = ids.filter(
            (id) =>
              !excluded.has(
                stringValue(
                  asRecord(nodesById.get(id)?.repository)?.nameWithOwner,
                )?.toLowerCase() ?? "",
              ),
          );
          return allowed.length
            ? yield* github.query({
                cwd,
                document: PR_HUB_MERGE_STATE_QUERY,
                variables: { ids: allowed },
              })
            : { data: { nodes: [] } };
        }),
      );
      for (const [id, state] of calculated) {
        const node = nodesById.get(id)!;
        nodesById.set(id, {
          ...node,
          mergeable: state.mergeable,
          mergeStateStatus: state.mergeStateStatus,
        });
      }

      return {
        nodesById,
        degraded,
        ...(errorMessage ? { errorMessage } : {}),
      };
    });

  const discoveryGeneration = (viewerId: string) =>
    sql<{
      generation: string;
    }>`SELECT json_extract(payload_json, '$.generation') AS generation FROM pr_hub_sync_tasks
    WHERE provider_kind = 'github' AND host = ${host} AND viewer_id = ${viewerId} AND kind = 'membership' ORDER BY task_key`.pipe(
      Effect.map((rows) => rows.map((row) => row.generation).join(":")),
      Effect.orDie,
    );

  const fetchGraphql = (
    viewer: ViewerIdentity,
    bypassConditional = false,
  ): Effect.Effect<FetchResult, never> =>
    Effect.gen(function* () {
      const queries = buildSearchQueries(viewer.login, viewer.teams);
      const account = {
        host,
        viewerId: String(viewer.context.viewerId),
        viewerLogin: viewer.login,
        viewerTeams: viewer.teams,
      };
      const currentSettings = yield* settings.getSettings.pipe(Effect.orDie);
      const generationBefore = yield* discoveryGeneration(account.viewerId);
      const excluded = new Set(
        currentSettings.prHub.excludeRepos.map((repo) => repo.toLowerCase()),
      );
      const teamListCapped = viewer.teams.length > TEAM_QUERY_CHUNK_SIZE * TEAM_QUERY_CHUNK_COUNT;
      const queryByAlias: Record<string, string> = {
        review_requested: queries.rr,
        team_review_0: queries.tr0,
        team_review_1: queries.tr1,
        team_review_2: queries.tr2,
        team_review_3: queries.tr3,
        team_review_4: queries.tr4,
        author: queries.au,
        assignee: queries.as,
        mentioned: queries.me,
        involved: queries.inv,
        recently_closed: queries.closed,
      };
      const searchScopes = new Map<string, SearchTask>();
      const scopedQueries = { ...queries };
      const variableByAlias = {
        review_requested: "rr",
        team_review_0: "tr0",
        team_review_1: "tr1",
        team_review_2: "tr2",
        team_review_3: "tr3",
        team_review_4: "tr4",
        author: "au",
        assignee: "as",
        mentioned: "me",
        involved: "inv",
        recently_closed: "closed",
      } as const;
      for (const [alias, variable] of Object.entries(variableByAlias)) {
        const scope = yield* beginPrHubSearch(account, alias, queryByAlias[alias]!).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.orDie,
        );
        searchScopes.set(alias, scope);
        scopedQueries[variable] = scope.query;
      }
      const result = yield* Effect.exit(
        github.query({
          cwd,
          document: PR_HUB_SEARCH_QUERY,
          variables: scopedQueries,
        }),
      );
      if (Exit.isFailure(result)) {
        yield* Effect.logWarning("PR Hub GraphQL search failed; using fallback search", {
          detail: causeUserMessage(result.cause, "GitHub GraphQL search request failed."),
        });
        return yield* fetchFallback(
          viewer,
          `${causeUserMessage(result.cause, "GitHub GraphQL search request failed.")} Showing fallback search results.`,
        );
      }

      const response = asRecord(result.value);
      const data = asRecord(response?.data);
      if (!data) {
        return yield* fetchFallback(viewer, "GitHub GraphQL response did not contain data.");
      }
      const graphQlErrors = asArray(response?.errors);
      const graphQlErrorMessage =
        graphQlErrors.length > 0
          ? `GitHub GraphQL returned partial errors for ${graphQlErrors.length} bucket(s).`
          : undefined;

      const aliasNames = [
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
      const aliasesByNodeId = new Map<string, Set<string>>();
      const cappedBuckets: string[] = [];
      for (const alias of aliasNames) {
        const connection = asRecord(data[alias]);
        if (!connection) continue;
        const nodes = nodeArray(connection);
        if (numberValue(connection.issueCount) > nodes.length) cappedBuckets.push(alias);
        for (const node of nodes) {
          const id = stringValue(node.id);
          if (!id) continue;
          const aliases = aliasesByNodeId.get(id) ?? new Set<string>();
          aliases.add(
            alias === "recently_closed"
              ? "author"
              : alias.startsWith("team_review_")
                ? "team_review"
                : alias,
          );
          aliasesByNodeId.set(id, aliases);
        }
      }

      for (const alias of aliasNames) {
        yield* ingestPrHubSearch(account, searchScopes.get(alias)!, data[alias], excluded).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.orDie,
        );
      }
      const configured = yield* getProjectRepositoryCandidates();
      const manuallyTracked = yield* sql<{
        repo: string;
      }>`SELECT DISTINCT repo FROM pr_hub_viewer_state WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${account.viewerId} AND json_extract(viewer_payload_json, '$.manuallyTracked') = 1`.pipe(
        Effect.orDie,
      );
      const knownRepos = yield* Effect.exit(
        syncPrHubRepositories(
          account,
          configured.map((candidate) => candidate.repository.nameWithOwner),
          [
            { alias: "involved", query: queries.inv },
            { alias: "review_requested", query: queries.rr },
            ...[queries.tr0, queries.tr1, queries.tr2, queries.tr3, queries.tr4]
              .filter((query) => query !== NO_MATCH_SEARCH_QUERY)
              .map((query, index) => ({ alias: `team_review_${index}`, query })),
          ],
          excluded,
          (document, variables) => github.query({ cwd, document, variables }),
          Date.now(),
          manuallyTracked.map((row) => row.repo),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      if (Exit.isFailure(knownRepos)) cappedBuckets.push("known_repositories");
      const continued = yield* Effect.exit(
        resumePrHubSearch(account, excluded, (document, variables) =>
          github.query({ cwd, document, variables }),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      if (Exit.isFailure(continued)) cappedBuckets.push("discovery_continuation");
      const notificationDiscovery = currentSettings.prHub.discoverNotifications
        ? yield* Effect.exit(
            discoverNotificationSubjects(account, excluded, (endpoint, query) =>
              githubCli
                .request({
                  cwd,
                  context: viewer.context,
                  method: "GET",
                  endpoint,
                  ...(query ? { query } : {}),
                  ...(bypassConditional
                    ? {}
                    : {
                        cache: {
                          identity: "notification-discovery-v1",
                          validate: (body: unknown) =>
                            endpoint === "notifications"
                              ? Array.isArray(body) &&
                                body.every(
                                  (item) =>
                                    typeof asRecord(asRecord(item)?.subject)?.type === "string",
                                )
                              : typeof asRecord(body)?.node_id === "string",
                        },
                      }),
                })
                .pipe(Effect.mapError(mapGitHubCliError)),
            ),
          )
        : null;
      yield* enqueuePrHubTracked(account, excluded).pipe(Effect.orDie);
      const hydration = yield* selectPrHubHydration(account, excluded).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
      aliasesByNodeId.clear();
      for (const [nodeId, task] of hydration)
        aliasesByNodeId.set(
          nodeId,
          new Set(
            task.aliases.map((alias) =>
              alias === "recently_closed"
                ? "author"
                : alias.startsWith("team_review_")
                  ? "team_review"
                  : alias,
            ),
          ),
        );
      const details = yield* fetchGraphqlDetails([...aliasesByNodeId.keys()], hydration);
      if (aliasesByNodeId.size > 0 && details.nodesById.size === 0) {
        return yield* fetchFallback(
          viewer,
          `${details.errorMessage ?? "GitHub GraphQL PR detail request failed."} Showing fallback search results.`,
        );
      }

      let attentionIncomplete = false;
      const detailedNodes = new Map(details.nodesById);
      // Continue only hydrated, relevant PRs, using the same captured account and host budgets.
      for (const [id, node] of details.nodesById) {
        if (node.state !== "OPEN" || asRecord(node.repository)?.isArchived === true) continue;
        const currentSettings = yield* settings.getSettings.pipe(Effect.orDie);
        const repository = stringValue(asRecord(node.repository)?.nameWithOwner)?.toLowerCase();
        if (
          currentSettings.prHub.excludeRepos.some(
            (repo) => repo.trim().toLowerCase() === repository,
          )
        )
          continue;
        const continued = yield* continuePrConnectionPagination(
          account,
          node,
          (document, variables) => github.query({ cwd, document, variables }),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie);
        detailedNodes.set(id, { ...continued.node, reviewFactsComplete: continued.complete });
        if (!continued.complete) {
          attentionIncomplete = true;
        }
      }

      for (const [id, node] of detailedNodes) {
        if (
          node.state !== "OPEN" ||
          node.reviewDecision !== "APPROVED" ||
          stringValue(asRecord(node.author)?.login)?.toLowerCase() !== viewer.login.toLowerCase()
        )
          continue;
        const requirements = yield* readMergeRequirements(node, (endpoint, query) =>
          githubCli
            .request({
              cwd,
              context: viewer.context,
              method: "GET",
              endpoint,
              query,
              ...(bypassConditional
                ? {}
                : {
                    cache: {
                      identity: JSON.stringify([node.baseRefName, node.baseRefOid]),
                      validate: isBranchRulePage,
                    },
                  }),
            })
            .pipe(Effect.mapError(mapGitHubCliError)),
        );
        detailedNodes.set(id, { ...node, prHubMergeRequirements: requirements });
      }
      const teamSet = new Set(viewer.teams);
      const pullRequests = [...aliasesByNodeId.entries()]
        .map(([nodeId, aliases]) => {
          const node = detailedNodes.get(nodeId);
          if (!node) return null;
          return normalizeGraphqlPr({
            node,
            aliases,
            host,
            viewerLogin: viewer.login,
            viewerTeams: teamSet,
          });
        })
        .filter((pr): pr is NormalizedPr => pr !== null);

      const pending = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${host} AND viewer_id = ${account.viewerId} AND kind IN ('search', 'hydrate')`.pipe(
        Effect.orDie,
      );
      if ((pending[0]?.count ?? 0) > details.nodesById.size)
        cappedBuckets.push("monitoring_backlog");
      if (teamListCapped) cappedBuckets.push("team_review_teams");
      const missingDetailCount = aliasesByNodeId.size - details.nodesById.size;
      const missingDetailMessage =
        missingDetailCount > 0
          ? `GitHub GraphQL returned incomplete PR detail data for ${missingDetailCount} PR(s).`
          : undefined;
      const detailErrorMessage = attentionIncomplete
        ? "Review-thread and review-history pagination is incomplete; monitoring will resume on the next poll."
        : details.degraded
          ? (details.errorMessage ?? "GitHub GraphQL returned partial PR detail data.")
          : missingDetailMessage;
      const detailDegraded = attentionIncomplete || details.degraded || missingDetailCount > 0;

      const work = yield* sql<{
        repositories: number;
        searches: number;
        repo_searches: number;
        hydrations: number;
      }>`SELECT
        sum(CASE WHEN kind = 'known_repository' THEN 1 ELSE 0 END) AS repositories,
        sum(CASE WHEN kind = 'search' AND instr(json_extract(payload_json, '$.query'), ' repo:') = 0 THEN 1 ELSE 0 END) AS searches,
        sum(CASE WHEN kind = 'search' AND instr(json_extract(payload_json, '$.query'), ' repo:') > 0 THEN 1 ELSE 0 END) AS repo_searches,
        sum(CASE WHEN kind = 'hydrate' THEN 1 ELSE 0 END) AS hydrations
        FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${host} AND viewer_id = ${account.viewerId}`.pipe(
        Effect.orDie,
      );
      const remainingHydrations = Math.max(0, (work[0]?.hydrations ?? 0) - pullRequests.length);
      const repoSearches = work[0]?.repo_searches ?? 0;
      const globalSearches = work[0]?.searches ?? 0;
      const unknownSearch = aliasNames.some((alias) => {
        const connection = asRecord(data[alias]);
        return (
          !connection ||
          (numberValue(connection.issueCount) > nodeArray(connection).length &&
            asRecord(connection.pageInfo)?.hasNextPage !== true)
        );
      });
      const generation = yield* discoveryGeneration(account.viewerId);
      const coverage: NonNullable<PrHubSnapshot["coverage"]> = [
        {
          scope: "notification_subjects",
          status:
            notificationDiscovery === null
              ? "not_scanned"
              : Exit.isSuccess(notificationDiscovery) &&
                  notificationDiscovery.value &&
                  remainingHydrations === 0
                ? "complete"
                : "partial",
          checkedAt: new Date().toISOString(),
          description:
            notificationDiscovery === null
              ? "Optional notification-subject discovery is disabled."
              : Exit.isFailure(notificationDiscovery)
                ? "Notification-subject discovery is unavailable or incomplete. Check notification read permissions; other monitoring sources continue."
                : notificationDiscovery.value
                  ? "Available notification subjects traversed. GitHub notification read state was not changed."
                  : "Notification-subject traversal is in progress and resumes on the next poll. GitHub notification read state is unchanged.",
        },
        {
          scope: "known_repositories",
          status:
            Exit.isSuccess(knownRepos) &&
            knownRepos.value &&
            repoSearches === 0 &&
            remainingHydrations === 0 &&
            !attentionIncomplete
              ? "complete"
              : "partial",
          checkedAt: new Date().toISOString(),
          remainingTasks: repoSearches + remainingHydrations,
          description: `${work[0]?.repositories ?? 0} known repositories; ${repoSearches} search pages/partitions and ${remainingHydrations} PR detail reads remain.${Exit.isFailure(knownRepos) ? " Affiliation enumeration is unavailable." : knownRepos.value ? " Affiliation traversal completed." : " Affiliation traversal is still in progress."}`,
        },
        {
          scope: "global_relationship_search",
          status:
            generation === generationBefore &&
            !unknownSearch &&
            !graphQlErrors.length &&
            !viewer.teamLookupError &&
            globalSearches === 0 &&
            remainingHydrations === 0 &&
            !attentionIncomplete
              ? "complete"
              : "partial",
          checkedAt: new Date().toISOString(),
          remainingTasks: globalSearches + remainingHydrations,
          limits: cappedBuckets,
          description: `Search-based relationship coverage: ${globalSearches} pages/partitions and ${remainingHydrations} PR detail reads remain. GitHub search cannot prove coverage of every accessible repository.`,
        },
        {
          ...defaultPrHubCoverage(new Date().toISOString())[2]!,
          status:
            !attentionIncomplete &&
            [...(yield* getSnapshot).pullRequests].every((previous) =>
              pullRequests.some(
                (pr) =>
                  pr.repository.nameWithOwner === previous.repository.nameWithOwner &&
                  pr.number === previous.number,
              ),
            )
              ? "complete"
              : "partial",
        },
      ];

      return {
        coverage: coverage.map((scope) => ({ ...scope, generation })),
        pullRequests,
        cappedBuckets,
        degraded: graphQlErrors.length > 0 || detailDegraded || viewer.teamLookupError !== null,
        errorMessage:
          graphQlErrorMessage ??
          detailErrorMessage ??
          (viewer.teamLookupError
            ? "GitHub team review requests may be incomplete; failed to load viewer teams."
            : undefined),
      };
    });

  function fetchFallback(
    viewer: ViewerIdentity,
    message: string,
  ): Effect.Effect<FetchResult, never> {
    return Effect.gen(function* () {
      const buckets = [
        { alias: "review_requested", args: ["--review-requested", "@me", "--state", "open"] },
        { alias: "author", args: ["--author", "@me", "--state", "open"] },
        { alias: "assignee", args: ["--assignee", "@me", "--state", "open"] },
        { alias: "mentioned", args: ["--mentions", "@me", "--state", "open"] },
        { alias: "involved", args: ["--involves", "@me", "--state", "open"] },
      ] as const;
      const nodesByUrl = new Map<string, { node: Record<string, unknown>; aliases: Set<string> }>();
      for (const bucket of buckets) {
        const exit = yield* Effect.exit(
          github.searchPullRequests({ cwd, qualifiers: bucket.args, limit: 50 }),
        );
        if (Exit.isFailure(exit)) continue;
        for (const rawNode of asArray(exit.value)) {
          const node = asRecord(rawNode);
          const url = node ? stringValue(node.url) : null;
          if (!node || !url) continue;
          const entry = nodesByUrl.get(url) ?? { node, aliases: new Set<string>() };
          entry.aliases.add(bucket.alias);
          nodesByUrl.set(url, entry);
        }
      }
      const pullRequests = [...nodesByUrl.values()]
        .map((entry) =>
          normalizeFallbackPr({
            node: entry.node,
            aliases: entry.aliases,
            host,
            viewerLogin: viewer.login,
          }),
        )
        .filter((pr): pr is NormalizedPr => pr !== null);
      return {
        pullRequests,
        cappedBuckets: [],
        degraded: true,
        errorMessage: message,
      };
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed({
          pullRequests: [],
          cappedBuckets: [],
          degraded: true,
          errorMessage: message,
        }),
      ),
    );
  }

  const fetchReconciledPullRequestStates = (
    nodeIds: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, ReconciledPrState>, never> =>
    Effect.gen(function* () {
      const reconciled = new Map<string, ReconciledPrState>();
      for (let index = 0; index < nodeIds.length; index += RECONCILE_NODE_CHUNK_SIZE) {
        const ids = nodeIds.slice(index, index + RECONCILE_NODE_CHUNK_SIZE);
        if (ids.length === 0) continue;
        const result = yield* Effect.exit(
          github.query({
            cwd,
            document: PR_HUB_RECONCILE_QUERY,
            variables: { ids },
          }),
        );
        if (Exit.isFailure(result)) continue;
        const nodes = asArray(asRecord(asRecord(result.value)?.data)?.nodes);
        for (const rawNode of nodes) {
          const node = asRecord(rawNode);
          const nodeId = node ? stringValue(node.id) : null;
          if (!node || !nodeId) continue;
          const terminal = normalizeTerminalPullRequestState(node);
          if (terminal) reconciled.set(nodeId, terminal);
        }
      }
      return reconciled;
    });

  const fetchReconciledPullRequestStatesByNumber = (
    rows: ReadonlyArray<Pick<PersistedPrRow, "repo" | "number">>,
  ): Effect.Effect<ReadonlyMap<string, ReconciledPrState>, never> =>
    Effect.gen(function* () {
      const reconciled = new Map<string, ReconciledPrState>();
      for (let index = 0; index < rows.length; index += RECONCILE_REPO_NUMBER_CHUNK_SIZE) {
        const request = buildReconcileByNumberRequest(
          rows.slice(index, index + RECONCILE_REPO_NUMBER_CHUNK_SIZE),
        );
        if (!request) continue;
        const result = yield* Effect.exit(
          github.query({
            cwd,
            document: request.query,
            variables: request.variables,
          }),
        );
        if (Exit.isFailure(result)) continue;
        const data = asRecord(asRecord(result.value)?.data);
        if (!data) continue;
        for (const { alias, key } of request.aliases) {
          const repository = asRecord(data[alias]);
          const node = asRecord(repository?.pullRequest);
          if (!node) continue;
          const terminal = normalizeTerminalPullRequestState(node);
          if (terminal) reconciled.set(key, terminal);
        }
      }
      return reconciled;
    });

  return {
    fetchGraphql,
    fetchReconciledPullRequestStates,
    fetchReconciledPullRequestStatesByNumber,
  };
}
