import { isBranchRulePage, readMergeRequirements } from "./mergeRequirements.ts";

import { continuePrConnectionPagination } from "./attentionPagination.ts";

import { PR_HUB_MERGE_STATE_QUERY, recheckUnknownMergeStates } from "./mergeState.ts";

import type { SearchTask } from "./discovery.ts";

import { githubRequestScheduler, GitHubRequestPriority } from "../git/githubRequestScheduler.ts";

import { defaultPrHubCoverage } from "./readModel.ts";

import { mapGitHubCliError } from "../sourceControl/GitHubSourceControlProvider.ts";

import { type PrHubLocalCheckoutCandidate, type PrHubSnapshot } from "@t3tools/contracts";

import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  FetchResult,
  NormalizedPr,
  PR_HUB_DETAILS_CHUNK_SIZE,
  PR_HUB_DETAILS_QUERY,
  PR_HUB_RECONCILE_QUERY,
  buildPrHubSearchRequest,
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
  buildTrackedByNumberRequest,
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
    preparePrHubSearchFormat,
    ingestPrHubSearch,
    enqueuePrHubTracked,
    beginPrHubSearch,
    resumePrHubSearch,
    selectPrHubHydration,
    finishPrHubHydration,
    syncPrHubRepositories,
    discoverNotificationSubjects,
  } = context.discovery;
  const fetchGraphqlDetails = (
    nodeIds: ReadonlyArray<string>,
    priorities?: ReadonlyMap<
      string,
      { priority?: number; repository: string | null; number?: number }
    >,
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
            if (
              ids.length > 1 &&
              shouldSplitDetailChunk(result.cause) &&
              !githubRequestScheduler.status(host).retryAt
            ) {
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

      const knownIds: string[] = [];
      const numbered: Array<{ key: string; repo: string; number: number; priority: number }> = [];
      for (const key of nodeIds) {
        const task = priorities?.get(key);
        if (task?.number === undefined || !task.repository) knownIds.push(key);
        else
          numbered.push({
            key,
            repo: task.repository,
            number: task.number,
            priority: task.priority ?? 0,
          });
      }
      const hydrateNumberChunk = (targets: typeof numbered): Effect.Effect<void> =>
        Effect.gen(function* () {
          const request = buildTrackedByNumberRequest(targets);
          if (!request) return;
          const response = yield* Effect.exit(
            github.query({ cwd, document: request.query, variables: request.variables }),
          );
          if (
            Exit.isFailure(response) &&
            targets.length > 1 &&
            shouldSplitDetailChunk(response.cause) &&
            !githubRequestScheduler.status(host).retryAt
          ) {
            const mid = Math.ceil(targets.length / 2);
            yield* hydrateNumberChunk(targets.slice(0, mid));
            if (!githubRequestScheduler.status(host).retryAt)
              yield* hydrateNumberChunk(targets.slice(mid));
            return;
          }
          const body = Exit.isSuccess(response) ? asRecord(response.value) : null;
          const data = asRecord(body?.data);
          if (asArray(body?.errors).length > 0) {
            degraded = true;
            errorMessage ??= "GitHub GraphQL returned partial saved PR lookup errors.";
          }
          for (const { alias, key } of request.aliases) {
            const task = targets.find((target) => `${target.repo}#${target.number}` === key)!;
            const node = asRecord(asRecord(data?.[alias])?.pullRequest);
            if (
              node &&
              stringValue(node.id) &&
              stringValue(asRecord(node.repository)?.nameWithOwner)?.toLowerCase() ===
                task.repo.toLowerCase() &&
              node.number === task.number
            ) {
              nodesById.set(task.key, node);
            } else {
              degraded = true;
              errorMessage ??= Exit.isFailure(response)
                ? causeUserMessage(response.cause, "Saved PR lookup failed.")
                : "Saved PR lookup returned no accessible data.";
            }
          }
        });
      for (let index = 0; index < numbered.length; index += PR_HUB_DETAILS_CHUNK_SIZE) {
        if (githubRequestScheduler.status(host).retryAt) {
          degraded = true;
          break;
        }
        const targets = numbered.slice(index, index + PR_HUB_DETAILS_CHUNK_SIZE);
        const rank = Math.max(...targets.map((target) => target.priority));
        yield* hydrateNumberChunk(targets).pipe(
          Effect.provideService(
            GitHubRequestPriority,
            rank >= 2 ? "attention" : rank === 1 ? "changed" : "cold",
          ),
        );
      }
      for (let index = 0; index < knownIds.length; index += PR_HUB_DETAILS_CHUNK_SIZE) {
        const ids = knownIds.slice(index, index + PR_HUB_DETAILS_CHUNK_SIZE);
        if (ids.length === 0) continue;
        const rank = Math.max(...ids.map((id) => priorities?.get(id)?.priority ?? 0));
        if (githubRequestScheduler.status(host).retryAt) {
          degraded = true;
          break;
        }
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

  const hydrate = (
    viewer: ViewerIdentity,
    hydration: Map<
      string,
      { aliases: string[]; priority?: number; repository: string | null; number?: number }
    >,
    bypassConditional: boolean,
  ) =>
    Effect.gen(function* () {
      const account = { host, viewerId: String(viewer.context.viewerId) };
      const aliasesByNodeId = new Map(
        [...hydration].map(([id, task]) => [
          id,
          new Set(
            task.aliases.map((alias) =>
              alias === "recently_closed"
                ? "author"
                : alias.startsWith("team_review_")
                  ? "team_review"
                  : alias,
            ),
          ),
        ]),
      );
      const details = yield* fetchGraphqlDetails([...aliasesByNodeId.keys()], hydration);
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

      return {
        pullRequests,
        details,
        attentionIncomplete,
        missingDetailCount: hydration.size - pullRequests.length,
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

  const loadGlobalSearchSources = (viewerId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        task_key: string;
        payload_json: string;
      }>`SELECT task_key, payload_json FROM pr_hub_sync_tasks
      WHERE provider_kind = 'github' AND host = ${host} AND viewer_id = ${viewerId} AND kind = 'source_watermark'
        AND instr(json_extract(payload_json, '$.task.query'), ' repo:') = 0
      ORDER BY updated_at DESC, task_key DESC`.pipe(Effect.orDie);
      const sources = new Map<string, { complete: boolean; task: SearchTask }>();
      for (const row of rows) {
        const source = JSON.parse(row.payload_json) as { complete: boolean; task: SearchTask };
        sources.set(row.task_key, source);
      }
      return sources;
    });

  const fetchGraphql = (
    viewer: ViewerIdentity,
    bypassConditional: boolean,
    persistHydration: (prs: readonly NormalizedPr[]) => Effect.Effect<void>,
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
      yield* preparePrHubSearchFormat(account).pipe(Effect.orDie);
      const hydrateAndPersist = (tasks: Parameters<typeof hydrate>[1]) =>
        Effect.gen(function* () {
          const result = yield* hydrate(viewer, tasks, bypassConditional);
          yield* persistHydration(result.pullRequests);
          const completed = [...tasks]
            .filter(([key, task]) =>
              result.pullRequests.some(
                (pr) =>
                  pr.nodeId === key ||
                  (pr.repository.nameWithOwner.toLowerCase() === task.repository?.toLowerCase() &&
                    pr.number === task.number),
              ),
            )
            .map(([key]) => key);
          yield* finishPrHubHydration(account, completed).pipe(Effect.orDie);
          return result;
        });
      let recoveredPullRequests: readonly NormalizedPr[] = [];
      let recoveryError: string | undefined;
      if (!githubRequestScheduler.status(host).retryAt) {
        yield* enqueuePrHubTracked(account, excluded).pipe(Effect.orDie);
        const recovery = yield* selectPrHubHydration(account, excluded).pipe(Effect.orDie);
        if (recovery.size > 0) {
          const recovered = yield* hydrateAndPersist(recovery);
          recoveredPullRequests = recovered.pullRequests;
          recoveryError =
            recovered.details.errorMessage ??
            (recovered.attentionIncomplete || recovered.missingDetailCount > 0
              ? "Saved PR revalidation is incomplete; remaining work will resume."
              : undefined);
        }
      }
      const teamListCapped = viewer.teams.length > TEAM_QUERY_CHUNK_SIZE * TEAM_QUERY_CHUNK_COUNT;
      const activeAliases = queries.map((bucket) => bucket.alias);
      const currentSources = new Map<string, string>();
      const data: Record<string, unknown> = {};
      const graphQlErrors: unknown[] = [];
      let searchErrorMessage: string | undefined;
      for (const bucket of queries) {
        const { alias } = bucket;
        const scope = yield* beginPrHubSearch(
          account,
          alias,
          bucket.query,
          Date.now(),
          bucket.updatedSince,
        ).pipe(Effect.orDie);
        if (scope.sourceKey) currentSources.set(alias, scope.sourceKey);
        // An unfinished scope already has its exact next page durably queued.
        if (scope.queued) continue;
        const result = yield* Effect.exit(
          github.query({
            cwd,
            ...buildPrHubSearchRequest([{ ...bucket, query: scope.query }]),
          }),
        );
        if (Exit.isFailure(result)) {
          searchErrorMessage ??= causeUserMessage(
            result.cause,
            "GitHub GraphQL search request failed.",
          );
          yield* ingestPrHubSearch(account, scope, null, excluded).pipe(Effect.orDie);
          if (githubRequestScheduler.status(host).retryAt) break;
          continue;
        }
        const response = asRecord(result.value);
        graphQlErrors.push(...asArray(response?.errors));
        data[alias] = asRecord(response?.data)?.[alias];
        yield* ingestPrHubSearch(account, scope, data[alias], excluded).pipe(Effect.orDie);
      }
      const graphQlErrorMessage =
        searchErrorMessage ??
        (graphQlErrors.length > 0
          ? `GitHub GraphQL returned partial errors for ${graphQlErrors.length} bucket(s).`
          : undefined);
      if (searchErrorMessage)
        yield* Effect.logWarning("PR Hub search incomplete", { detail: searchErrorMessage });

      const cappedBuckets: string[] = [];
      for (const alias of activeAliases) {
        const connection = asRecord(data[alias]);
        if (connection && numberValue(connection.issueCount) > nodeArray(connection).length)
          cappedBuckets.push(alias);
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
          queries.filter(
            (bucket) =>
              bucket.alias === "involved" ||
              bucket.alias === "review_requested" ||
              bucket.alias.startsWith("team_review_"),
          ),
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
      if (Exit.isFailure(continued)) {
        cappedBuckets.push("discovery_continuation");
        searchErrorMessage ??= causeUserMessage(
          continued.cause,
          "Search continuation is incomplete.",
        );
      }
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
      const hydration = githubRequestScheduler.status(host).retryAt
        ? new Map()
        : yield* selectPrHubHydration(account, excluded).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.orDie,
          );
      const { pullRequests, details, attentionIncomplete, missingDetailCount } =
        yield* hydrateAndPersist(hydration);

      const pending = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${host} AND viewer_id = ${account.viewerId} AND kind IN ('search', 'hydrate')`.pipe(
        Effect.orDie,
      );
      if ((pending[0]?.count ?? 0) > 0) cappedBuckets.push("monitoring_backlog");
      if (teamListCapped) cappedBuckets.push("team_review_teams");
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
      const remainingHydrations = work[0]?.hydrations ?? 0;
      const refreshedPullRequests = [
        ...new Map([...recoveredPullRequests, ...pullRequests].map((pr) => [pr.url, pr])).values(),
      ];
      const repoSearches = work[0]?.repo_searches ?? 0;
      const globalSearches = work[0]?.searches ?? 0;
      const completedSources = yield* loadGlobalSearchSources(account.viewerId);
      const unknownSearch = activeAliases.some(
        (alias) => completedSources.get(currentSources.get(alias) ?? "")?.complete !== true,
      );
      // Incompleteness limits reconciliation, but is not itself a failed refresh.
      if (unknownSearch && !cappedBuckets.includes("monitoring_backlog"))
        cappedBuckets.push("incomplete_search");
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
              refreshedPullRequests.some(
                (pr) =>
                  pr.repository.nameWithOwner.toLowerCase() ===
                    previous.repository.nameWithOwner.toLowerCase() &&
                  pr.number === previous.number,
              ),
            )
              ? "complete"
              : "partial",
        },
      ];

      const fallback =
        searchErrorMessage || (details.degraded && pullRequests.length === 0)
          ? yield* fetchFallback(
              viewer,
              searchErrorMessage ?? details.errorMessage ?? "PR detail recovery is incomplete.",
            )
          : null;
      return {
        coverage: coverage.map((scope) => ({ ...scope, generation })),
        pullRequests: [
          ...refreshedPullRequests,
          ...(fallback?.pullRequests ?? []).filter(
            (pr) => !refreshedPullRequests.some((current) => current.url === pr.url),
          ),
        ],
        cappedBuckets,
        degraded:
          !!recoveryError ||
          !!searchErrorMessage ||
          graphQlErrors.length > 0 ||
          detailDegraded ||
          viewer.teamLookupError !== null,
        errorMessage:
          fallback?.errorMessage ??
          recoveryError ??
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
      if (githubRequestScheduler.status(host).retryAt)
        return {
          pullRequests: [],
          cappedBuckets: [],
          degraded: true,
          errorMessage: `${message} Fallback search deferred until the GitHub retry window.`,
        };
      let succeeded = 0;
      let failed = 0;
      let deferred = false;
      const nodesByUrl = new Map<string, { node: Record<string, unknown>; aliases: Set<string> }>();
      for (const bucket of buckets) {
        if (githubRequestScheduler.status(host).retryAt) {
          deferred = true;
          break;
        }
        const exit = yield* Effect.exit(
          github.searchPullRequests({ cwd, qualifiers: bucket.args, limit: 50 }),
        );
        if (Exit.isFailure(exit)) {
          failed++;
          continue;
        }
        succeeded++;
        for (const rawNode of asArray(exit.value)) {
          const node = asRecord(rawNode);
          const url = node ? stringValue(node.url) : null;
          if (!node || !url) continue;
          const entry = nodesByUrl.get(url) ?? { node, aliases: new Set<string>() };
          entry.aliases.add(bucket.alias);
          nodesByUrl.set(url, entry);
        }
      }
      const previous = yield* getSnapshot;
      const verifiedUrls = new Set(
        [...previous.pullRequests, ...previous.recentlyResolved]
          .filter((pr) => pr.lastVerifiedAt !== null)
          .map((pr) => pr.url),
      );
      const pullRequests = [...nodesByUrl.values()]
        .map((entry) =>
          normalizeFallbackPr({
            node: entry.node,
            aliases: entry.aliases,
            host,
            viewerLogin: viewer.login,
          }),
        )
        .filter((pr): pr is NormalizedPr => pr !== null && !verifiedUrls.has(pr.url));
      return {
        pullRequests,
        cappedBuckets: [],
        degraded: true,
        errorMessage: `${message} ${succeeded ? `Fallback search completed ${succeeded} of ${buckets.length} scopes.` : "Fallback search failed; no fallback results were retrieved."}${failed ? ` ${failed} scopes failed.` : ""}${deferred ? " Remaining scopes are deferred until the GitHub retry window." : ""}`,
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
