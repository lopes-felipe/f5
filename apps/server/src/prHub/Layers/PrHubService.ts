import { GitHubCliError } from "../../git/Errors.ts";
import { GitHubRequestPolicy } from "../../git/githubRequestPolicy.ts";
import { PrHubRepository } from "../Services/PrHubRepository.ts";
import { prHubActionError } from "../errors.ts";
import { PR_HUB_BRANCH_REQUIREMENTS_FIELDS, readMergeRequirements } from "../mergeRequirements.ts";

import { prComparisonsEqual } from "@t3tools/shared/prReview";
import { PrHubJobCoordinator } from "../Services/PrHubJobCoordinator.ts";

import { PrHubReviewOperations } from "../Services/PrHubReviewOperations.ts";
import { readPrDetailCache, type CachedPrDetailRead } from "../detailCache.ts";
import { fetchGitHubPrFiles } from "../githubPrFiles.ts";

import { GitHubCredentialScope } from "../../git/githubApi.ts";
import { GitHubRequestPriority, githubRequestScheduler } from "../../git/githubRequestScheduler.ts";
import { mapGitHubCliError } from "../../sourceControl/GitHubSourceControlProvider.ts";
import { PrHubDiscovery } from "../Services/PrHubDiscovery.ts";
import { excludePrHubRepositories, listPrHubPullRequests, prHubOverview } from "../readModel.ts";
import { decodeUnresolvedThreads, GITHUB_UNRESOLVED_THREADS_QUERY } from "../reviewThreads.ts";

import {
  PullRequestKey,
  type PrHubChanged,
  type PrHubDetailResult,
  type PrHubLocalCheckoutCandidate,
  type PrHubSnapshot,
  type PrHubTimelinePage,
  type PrHubUnresolvedThreadsResult,
  type PrRepositoryRef,
  type TrackedPullRequest,
} from "@t3tools/contracts";

import {
  parseGitHubPullRequestUrl,
  sourceControlPullRequestKeysEqual,
} from "@t3tools/shared/sourceControl";
import { Effect, Exit, Layer, Option, PubSub, Ref, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGitHubSourceControlProvider } from "../../sourceControl/GitHubSourceControlProvider.ts";
import {
  makeSourceControlProviderRegistry,
  SourceControlProviderError,
} from "../../sourceControl/SourceControlProvider.ts";
import { discoverSourceControlProviderIdentities } from "../../sourceControl/discovery.ts";
import { PrHubService, type PrHubServiceShape } from "../Services/PrHubService.ts";
import {
  decodeGitHubPrDetail,
  decodeGitHubPrTimeline,
  GITHUB_PR_DETAIL_QUERY,
  GITHUB_PR_TIMELINE_QUERY,
  githubTimelineVariables,
} from "../githubPrDetails.ts";

import {
  accountCwd,
  asArray,
  asRecord,
  buildTrackedPullRequest,
  causeErrorKind,
  causeUserMessage,
  DEFAULT_HOST,
  emptySnapshot,
  normalizeGraphqlPr,
  PR_HUB_DETAILS_QUERY,
  repositoryFromNameWithOwner,
  stringValue,
  ViewerIdentity,
  viewerLatestReview,
} from "../discoveryModel.ts";

const makePrHubService = Effect.gen(function* () {
  const discoveryService = yield* PrHubDiscovery;
  const { finishPrHubHydration, recordPrHubMembership } = discoveryService;
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const githubCli = yield* GitHubCli;
  const sourceControlProviders = makeSourceControlProviderRegistry([
    makeGitHubSourceControlProvider(githubCli),
  ]);
  const github = yield* sourceControlProviders.get("github");
  const git = yield* GitCore;
  const projects = yield* ProjectionProjectRepository;
  const host = DEFAULT_HOST;
  const providerKind = "github" as const;
  const cwd = accountCwd(serverConfig.cwd);
  const snapshotRef = yield* Ref.make<PrHubSnapshot | null>(null);
  const changePubSub = yield* PubSub.sliding<PrHubChanged>(1);
  const actionRefreshPubSub = yield* PubSub.sliding<void>(1);
  const jobCoordinator = yield* PrHubJobCoordinator;
  const viewerRef = yield* Ref.make<ViewerIdentity | null>(null);
  const detailCache = new Map<string, CachedPrDetailRead<PrHubDetailResult>>();
  const timelineCache = new Map<string, CachedPrDetailRead<PrHubTimelinePage>>();
  const threadsCache = new Map<string, CachedPrDetailRead<PrHubUnresolvedThreadsResult>>();

  const projectRepositoryCache = new Map<
    string,
    { checkedAt: number; repositories: PrRepositoryRef[] }
  >();
  const getProjectRepositoryCandidates = () =>
    Effect.gen(function* () {
      const allProjects = yield* projects.listAll().pipe(Effect.catch(() => Effect.succeed([])));
      const roots = new Set(
        allProjects
          .filter((project) => project.deletedAt === null)
          .map((project) => project.workspaceRoot),
      );
      for (const root of projectRepositoryCache.keys())
        if (!roots.has(root)) projectRepositoryCache.delete(root);
      const candidates: PrHubLocalCheckoutCandidate[] = [];
      for (const project of allProjects) {
        if (project.deletedAt !== null) continue;
        let cached = projectRepositoryCache.get(project.workspaceRoot);
        if (!cached || Date.now() - cached.checkedAt >= 15 * 60_000) {
          const remotes = yield* git.listRemotes(project.workspaceRoot).pipe(
            Effect.catch(() =>
              git.readConfigValue(project.workspaceRoot, "remote.origin.url").pipe(
                Effect.map((url) => (url ? [{ name: "origin", url }] : [])),
                Effect.catch(() => Effect.succeed([])),
              ),
            ),
          );
          const names = new Set(
            discoverSourceControlProviderIdentities(remotes, { githubHosts: [host] })
              .filter(
                (identity) =>
                  identity.kind === "github" && identity.host?.toLowerCase() === host.toLowerCase(),
              )
              .map((identity) => `${identity.owner}/${identity.repository}`),
          );
          cached = {
            checkedAt: Date.now(),
            repositories: [...names].map(repositoryFromNameWithOwner),
          };
          projectRepositoryCache.set(project.workspaceRoot, cached);
        }
        for (const repository of cached.repositories)
          candidates.push({
            projectId: project.projectId,
            projectTitle: project.title,
            cwd: project.workspaceRoot,
            repository,
          });
      }
      return candidates;
    });

  const repositoryService = yield* PrHubRepository;
  const repository = repositoryService.create({
    host,
    settings,
    snapshotRef,
    viewerRef,
    changePubSub,
    fetchReconciledPullRequestStates: (ids) => fetchReconciledPullRequestStates(ids),
    fetchReconciledPullRequestStatesByNumber: (rows) =>
      fetchReconciledPullRequestStatesByNumber(rows),
  });
  const { publishSnapshot, viewerStateMap, hydrateSnapshot, persistPullRequests } = repository;
  const getStoredSnapshot = Ref.get(snapshotRef).pipe(
    Effect.flatMap((snapshot) => {
      if (snapshot) return Effect.succeed(snapshot);
      return Effect.exit(resolveViewer).pipe(
        Effect.flatMap((viewerExit) => {
          if (Exit.isSuccess(viewerExit)) {
            return hydrateSnapshot(viewerExit.value).pipe(Effect.flatMap(publishSnapshot));
          }
          const kind = causeErrorKind(viewerExit.cause) ?? "generic";
          const message = causeUserMessage(viewerExit.cause, "Failed to resolve GitHub account.");
          const status =
            kind === "provider_missing"
              ? "gh_missing"
              : kind === "unauthenticated"
                ? "auth_required"
                : "error";
          return publishSnapshot(
            emptySnapshot({
              host,
              status,
              errorKind: kind,
              errorMessage: message,
            }),
          );
        }),
      );
    }),
  );

  const getSnapshot = getStoredSnapshot.pipe(
    Effect.flatMap((snapshot) =>
      settings.getSettings.pipe(
        Effect.flatMap((currentSettings) => {
          const excluded = new Set(
            currentSettings.prHub.excludeRepos.map((repo) => repo.trim().toLowerCase()),
          );
          const changed = JSON.stringify([...excluded].sort()) !== repository.scopeSignature();
          return (changed ? publishSnapshot(snapshot) : Effect.succeed(snapshot)).pipe(
            Effect.map((current) => excludePrHubRepositories(current, excluded)),
          );
        }),
      ),
    ),
    Effect.catch(() =>
      Effect.succeed(
        emptySnapshot({
          host,
          status: "error",
          errorMessage:
            "PR monitoring scope could not be loaded. Retry after settings are available.",
        }),
      ),
    ),
  );

  const resolveViewer = Effect.gen(function* () {
    const capture = yield* Effect.serviceOption(GitHubCredentialScope);
    const context = Option.isSome(capture)
      ? capture.value
      : yield* githubCli
          .getCredentialContext({ cwd, host })
          .pipe(Effect.mapError(mapGitHubCliError));
    const login = context.login;
    const cached = yield* Ref.get(viewerRef);
    if (
      cached?.context.generation === context.generation &&
      Date.now() - cached.teamsCheckedAt < 15 * 60_000
    )
      return cached;
    // A response for the old account must not retain a detail cache in the new account.
    if (cached?.context.generation !== context.generation) {
      detailCache.clear();
      timelineCache.clear();
      threadsCache.clear();
      yield* Ref.set(snapshotRef, null);
    }
    const teamsExit = yield* Effect.exit(
      github.getViewerTeams({ cwd }).pipe(Effect.provideService(GitHubCredentialScope, context)),
    );
    const teams = Exit.isSuccess(teamsExit)
      ? teamsExit.value
      : cached?.context.generation === context.generation
        ? cached.teams
        : [];
    const teamLookupError = Exit.isFailure(teamsExit)
      ? causeUserMessage(teamsExit.cause, "Failed to load GitHub team memberships.")
      : null;
    if (Exit.isSuccess(teamsExit))
      yield* recordPrHubMembership(
        { host, viewerId: String(context.viewerId) },
        "teams",
        teams,
      ).pipe(Effect.orDie);
    const viewer = { context, login, teams, teamLookupError, teamsCheckedAt: Date.now() };
    // Bind legacy preferences only after verifying this exact host/login. Their facts
    // remain unverified until the next successful hydration; never adopt the old blob.
    yield* sql`UPDATE OR IGNORE pr_hub_viewer_state SET viewer_id = ${String(context.viewerId)}
      WHERE provider_kind = ${providerKind} AND host = ${host} AND viewer_id = ${`legacy:${login.toLowerCase()}`} AND lower(viewer_login) = ${login.toLowerCase()}`.pipe(
      Effect.orDie,
    );
    yield* Ref.set(viewerRef, viewer);
    return viewer;
  });

  const {
    fetchGraphql,
    fetchReconciledPullRequestStates,
    fetchReconciledPullRequestStatesByNumber,
  } = discoveryService.create({
    host,
    cwd,
    settings,
    githubCli,
    github,
    getSnapshot,
    getProjectRepositoryCandidates,
  });
  const fetchAndPersist = jobCoordinator.createWorkflow({
    host,
    repository,
    getSnapshot,
    resolveViewer,
    fetchGraphql,
    finishPrHubHydration,
    viewerRef,
  });
  const refreshNow = yield* jobCoordinator.createRefresh((input) => fetchAndPersist(input.mode));

  yield* Stream.fromPubSub(actionRefreshPubSub).pipe(
    Stream.runForEach(() =>
      refreshNow({ mode: "force" }).pipe(
        Effect.provideService(GitHubRequestPriority, "background"),
        Effect.catchCause((cause) =>
          Effect.logWarning("PR Hub post-action refresh failed", {
            detail: causeUserMessage(cause, "PR Hub refresh failed after pull request action."),
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  const trackedPrByUrl = (
    url: string,
  ): Effect.Effect<TrackedPullRequest, SourceControlProviderError> =>
    getSnapshot.pipe(
      Effect.flatMap((snapshot) => {
        const pr =
          snapshot.pullRequests.find((candidate) => candidate.url === url) ??
          snapshot.recentlyResolved.find((candidate) => candidate.url === url);
        return pr
          ? Effect.succeed(pr)
          : Effect.fail(prHubActionError("Pull request is not tracked by PR Hub."));
      }),
    );

  const trackedPrByKey = (
    key: PullRequestKey,
  ): Effect.Effect<TrackedPullRequest, SourceControlProviderError> =>
    getSnapshot.pipe(
      Effect.flatMap((snapshot) => {
        const pr = [...snapshot.pullRequests, ...snapshot.recentlyResolved].find((candidate) =>
          sourceControlPullRequestKeysEqual(candidate.key, key),
        );
        return pr
          ? Effect.succeed(pr)
          : Effect.fail(prHubActionError("Pull request is not tracked by PR Hub."));
      }),
    );

  const repositoryParts = (pr: TrackedPullRequest) => {
    const separator = pr.repository.nameWithOwner.indexOf("/");
    if (separator <= 0 || separator === pr.repository.nameWithOwner.length - 1) {
      return Effect.fail(
        new SourceControlProviderError({
          provider: pr.provider,
          operation: "prHub.detail.resolveRepository",
          detail: `Invalid repository identity '${pr.repository.nameWithOwner}'.`,
          kind: "invalid_response",
          host: pr.host,
        }),
      );
    }
    return Effect.succeed({
      owner: pr.repository.nameWithOwner.slice(0, separator),
      repo: pr.repository.nameWithOwner.slice(separator + 1),
    });
  };

  const decodeDetailResponse = <A>(
    pr: TrackedPullRequest,
    operation: string,
    decode: () => A,
  ): Effect.Effect<A, SourceControlProviderError> =>
    Effect.try({
      try: decode,
      catch: (cause) =>
        new SourceControlProviderError({
          provider: pr.provider,
          operation,
          detail: cause instanceof Error ? cause.message : "GitHub returned invalid PR detail.",
          kind: "invalid_response",
          host: pr.host,
          cause,
        }),
    });

  const getDetail: PrHubServiceShape["getDetail"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const provider = yield* sourceControlProviders.get(pr.provider);
          const { owner, repo } = yield* repositoryParts(pr);
          const cacheKey = pr.key;
          return yield* readPrDetailCache({
            cache: detailCache,
            key: cacheKey,
            mode: input.mode ?? "if_stale",
            fetch: provider
              .query({
                cwd,
                host: pr.host,
                document: GITHUB_PR_DETAIL_QUERY,
                variables: { owner, repo, number: pr.number },
              })
              .pipe(
                Effect.flatMap((response) =>
                  decodeDetailResponse(pr, "prHub.getDetail.decode", () => {
                    const decoded = decodeGitHubPrDetail(response, pr);
                    return {
                      detail: decoded.detail,
                      stale: false,
                      refreshedAt: new Date().toISOString(),
                      ...(decoded.rateLimit ? { rateLimit: decoded.rateLimit } : {}),
                    } satisfies PrHubDetailResult;
                  }),
                ),
              ),
          });
        }),
      ),
    );

  const getTimeline: PrHubServiceShape["getTimeline"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const provider = yield* sourceControlProviders.get(pr.provider);
          const { owner, repo } = yield* repositoryParts(pr);
          const variables = yield* decodeDetailResponse(pr, "prHub.getTimeline.cursor", () =>
            githubTimelineVariables({ owner, repo, number: pr.number, cursor: input.cursor }),
          );
          return yield* readPrDetailCache({
            cache: timelineCache,
            key: `${pr.key}|${input.cursor ?? "first"}`,
            mode: input.mode ?? "if_stale",
            fetch: provider
              .query({
                cwd,
                host: pr.host,
                document: GITHUB_PR_TIMELINE_QUERY,
                variables,
              })
              .pipe(
                Effect.flatMap((response) =>
                  decodeDetailResponse(pr, "prHub.getTimeline.decode", () => {
                    const decoded = decodeGitHubPrTimeline(response, input.cursor);
                    return {
                      entries: [...decoded.entries],
                      pageInfo: decoded.pageInfo,
                      stale: false,
                      refreshedAt: new Date().toISOString(),
                    } satisfies PrHubTimelinePage;
                  }),
                ),
              ),
          });
        }),
      ),
    );

  const getUnresolvedThreads: PrHubServiceShape["getUnresolvedThreads"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const provider = yield* sourceControlProviders.get(pr.provider);
          const { owner, repo } = yield* repositoryParts(pr);
          return yield* readPrDetailCache({
            cache: threadsCache,
            key: `${pr.key}|${pr.headRefOid}`,
            mode: input.mode ?? "if_stale",
            fetch: Effect.suspend(() =>
              provider.query({
                cwd,
                host: pr.host,
                document: GITHUB_UNRESOLVED_THREADS_QUERY,
                variables: { owner, repo, number: pr.number },
              }),
            ).pipe(
              Effect.flatMap((response) =>
                decodeDetailResponse(pr, "prHub.getUnresolvedThreads.decode", () => ({
                  ...decodeUnresolvedThreads(response),
                  stale: false,
                  refreshedAt: new Date().toISOString(),
                })),
              ),
            ),
          });
        }),
      ),
    );

  const getFiles: PrHubServiceShape["getFiles"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const capture = yield* Effect.serviceOption(GitHubCredentialScope);
          if (Option.isNone(capture))
            return yield* new SourceControlProviderError({
              provider: pr.provider,
              host: pr.host,
              operation: "prHub.getFiles",
              kind: "unauthenticated",
              detail: "A verified account is required to read PR files.",
            });
          const context = capture.value;
          let reviewedHeadOid: string | undefined;
          if (input.comparisonMode === "changes_since_review") {
            if (!pr.nodeId)
              return yield* prHubActionError("The reviewed revision is not available for this PR.");
            const response = yield* github.query({
              cwd,
              document: PR_HUB_DETAILS_QUERY,
              variables: { ids: [pr.nodeId] },
            });
            const node = asRecord(asArray(asRecord(asRecord(response)?.data)?.nodes)[0]);
            const oid = node
              ? stringValue(asRecord(viewerLatestReview(node, context.login)?.commit)?.oid)
              : null;
            if (!oid)
              return yield* prHubActionError(
                "No completed review revision is available for this account.",
              );
            reviewedHeadOid = oid;
          }
          return yield* fetchGitHubPrFiles({
            account: context.generation,
            ...(reviewedHeadOid ? { reviewedHeadOid } : {}),
            key: pr.key,
            repository: pr.repository.nameWithOwner,
            number: pr.number,
            host: pr.host,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            request: (endpoint, query, cache) =>
              githubCli
                .request({
                  cwd,
                  context,
                  endpoint,
                  method: "GET",
                  ...(input.mode !== "force" && cache ? { cache } : {}),
                  ...(query ? { query } : {}),
                })
                .pipe(Effect.mapError(mapGitHubCliError)),
          });
        }),
      ),
    );

  const reviewOperations = yield* PrHubReviewOperations;
  const {
    getReviewDraft,
    saveReviewDraft,
    prepareComment,
    submitComment,
    getCommentOperation,
    recoverComment,
    prepareQuickReview,
    prepareReview,
    submitReview,
    getReviewOperation,
    cancelReviewPreparation,
    recoverReview,
    getReviewThreads,
    setReviewThreadState,
    replyReviewThread,
    getReplyOperation,
    getReplyDraft,
    recoverReply,
    saveReplyDraft,
    approve,
    requestChanges,
    comment,
    merge,
    markReady,
    reRequestReview,
    updateComment,
    setReaction,
    changeReviewers,
    updateBranch,
  } = reviewOperations.create({
    cwd,
    sourceControlProviders,
    trackedPrByKey,
    getFiles,
    prHubActionError,
    requestRefresh: PubSub.publish(actionRefreshPubSub, undefined).pipe(Effect.asVoid),
    invalidateThreads: () => threadsCache.clear(),
    getSnapshot,
    trackedPrByUrl,
    getDetail,
    getTimeline,
    timelineCache,
    decodeDetailResponse,
  });

  const listLocalCheckoutCandidates: PrHubServiceShape["listLocalCheckoutCandidates"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      const pr =
        snapshot.pullRequests.find((candidate) =>
          sourceControlPullRequestKeysEqual(candidate.key, input.key),
        ) ??
        snapshot.recentlyResolved.find((candidate) =>
          sourceControlPullRequestKeysEqual(candidate.key, input.key),
        );
      if (!pr) return [];
      const candidates = (yield* getProjectRepositoryCandidates()).filter(
        (candidate) =>
          candidate.repository.nameWithOwner.toLowerCase() ===
          pr.repository.nameWithOwner.toLowerCase(),
      );
      return candidates;
    });

  const track: PrHubServiceShape["track"] = (input) =>
    Effect.gen(function* () {
      const ref = parseGitHubPullRequestUrl(input.url, host);
      if (!ref) return yield* prHubActionError(`Enter an HTTPS pull request URL on ${host}.`);
      const current = yield* settings.getSettings.pipe(Effect.orDie);
      const excluded = new Set(current.prHub.excludeRepos.map((repo) => repo.trim().toLowerCase()));
      if (excluded.has(ref.repository.toLowerCase()))
        return yield* prHubActionError("This repository is excluded from PR monitoring.");
      const viewer = yield* resolveViewer;
      const response = yield* githubCli
        .request({
          cwd,
          context: viewer.context,
          method: "GET",
          endpoint: `repos/${ref.repository.split("/").map(encodeURIComponent).join("/")}/pulls/${ref.number}`,
        })
        .pipe(Effect.mapError(mapGitHubCliError));
      if (response.status !== 200)
        return yield* prHubActionError(
          "This PR could not be read with the selected GitHub account.",
        );
      const nodeId = stringValue(asRecord(response.body)?.node_id);
      if (!nodeId) return yield* prHubActionError("GitHub omitted the pull request identity.");
      const data = yield* github.query({
        cwd,
        document: PR_HUB_DETAILS_QUERY,
        variables: { ids: [nodeId] },
      });
      const node = asRecord(asArray(asRecord(asRecord(data)?.data)?.nodes)[0]);
      const normalized = node
        ? normalizeGraphqlPr({
            node,
            host,
            viewerLogin: viewer.login,
            viewerTeams: new Set(viewer.teams),
            aliases: new Set(["involved"]),
          })
        : null;
      if (
        !normalized ||
        normalized.number !== ref.number ||
        normalized.repository.nameWithOwner.toLowerCase() !== ref.repository.toLowerCase()
      )
        return yield* prHubActionError("GitHub returned an inconsistent pull request identity.");
      // Exclusion changes during an on-demand read take precedence over tracking.
      const latest = yield* settings.getSettings.pipe(Effect.orDie);
      if (
        latest.prHub.excludeRepos.some(
          (repo) => repo.trim().toLowerCase() === ref.repository.toLowerCase(),
        )
      )
        return yield* prHubActionError("This repository is excluded from PR monitoring.");
      const previous = yield* viewerStateMap(String(viewer.context.viewerId));
      const pr = {
        ...buildTrackedPullRequest(
          normalized,
          viewer.login,
          previous.get(`${normalized.repository.nameWithOwner}#${ref.number}`),
        ),
        manuallyTracked: true,
      };
      yield* persistPullRequests(viewer, [pr], {
        excludedRepos: excluded,
        reconcilePolicy: "terminal_only",
        skipReconciliation: true,
      });
      const activeViewer = yield* Ref.get(viewerRef);
      if (activeViewer?.context.generation === viewer.context.generation)
        yield* hydrateSnapshot(viewer).pipe(Effect.flatMap(publishSnapshot));
      return pr;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(SourceControlProviderError)(cause)
          ? cause
          : prHubActionError("The PR could not be tracked. Existing records were preserved."),
      ),
    );

  const {
    acknowledgeAttention,
    markSeen,
    markNotified,
    snooze,
    unsnooze,
    ignore,
    clearData,
    claimNotifications,
    acknowledgeNotifications,
  } = repository.createViewerActions({
    getSnapshot,
    resolveViewer,
    clearCaches: () => {
      detailCache.clear();
      timelineCache.clear();
      threadsCache.clear();
    },
  });
  const operations = {
    getSnapshot,
    refreshNow,
    startMonitoring: jobCoordinator.startMonitoring(refreshNow),
    claimNotifications,
    acknowledgeNotifications,
    streamChanges: Stream.fromPubSub(changePubSub),
    getOverview: (input) =>
      getSnapshot.pipe(
        Effect.map((snapshot) => ({
          ...prHubOverview(snapshot, snapshot.revision ?? "0", input.stalledBefore),
          scheduler: githubRequestScheduler.status(host),
        })),
      ),
    listPullRequests: (input) =>
      getSnapshot.pipe(
        Effect.map((snapshot) => listPrHubPullRequests(snapshot, snapshot.revision ?? "0", input)),
      ),
    approve,
    requestChanges,
    comment,
    merge,
    markReady,
    reRequestReview,
    snooze,
    unsnooze,
    ignore,
    acknowledgeAttention,
    markSeen,
    markNotified,
    listLocalCheckoutCandidates,
    getDetail,
    getTimeline,
    getFiles,
    getUnresolvedThreads,
    replyReviewThread,
    getReplyOperation,
    getReplyDraft,
    recoverReply,
    saveReplyDraft,
    getReviewThreads,
    setReviewThreadState,
    getReviewDraft,
    saveReviewDraft,
    prepareComment,
    submitComment,
    getCommentOperation,
    recoverComment,
    prepareQuickReview,
    prepareReview,
    submitReview,
    getReviewOperation,
    cancelReviewPreparation,
    recoverReview,
    updateComment,
    setReaction,
    changeReviewers,
    updateBranch,
    clearData,
    track,
  } satisfies PrHubServiceShape;
  const withAccount = <A, E>(
    effect: Effect.Effect<A, E>,
    expectedGeneration?: string,
  ): Effect.Effect<A, E | SourceControlProviderError> =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      const context = yield* githubCli
        .getCredentialContext({ cwd, host })
        .pipe(Effect.mapError(mapGitHubCliError));
      if (
        snapshot.account?.generation !== context.generation ||
        (expectedGeneration !== undefined && expectedGeneration !== context.generation)
      ) {
        const viewer = yield* resolveViewer.pipe(
          Effect.provideService(GitHubCredentialScope, context),
        );
        yield* hydrateSnapshot(viewer).pipe(Effect.flatMap(publishSnapshot));
        return yield* prHubActionError(
          "The GitHub account changed. Refresh PR Hub before continuing.",
        );
      }
      const result = yield* effect.pipe(Effect.provideService(GitHubCredentialScope, context));
      const current = yield* Ref.get(viewerRef);
      if (current?.context.generation !== context.generation)
        return yield* prHubActionError("The GitHub account changed while the request was running.");
      return result;
    });
  const withPrAccount = <A, E>(
    effect: Effect.Effect<A, E>,
    input: {
      key?: PullRequestKey | undefined;
      url?: string | undefined;
      accountGeneration?: string | undefined;
      expectedComparison?: import("@t3tools/contracts").PrHubComparisonIdentity | undefined;
    },
    writable = true,
    action: "comment" | "review" | "merge" | "update" = "comment",
  ): Effect.Effect<A, E | SourceControlProviderError> =>
    withAccount(
      Effect.gen(function* () {
        const pr = input.key ? yield* trackedPrByKey(input.key) : yield* trackedPrByUrl(input.url!);
        if (writable && pr.repositoryArchived)
          return yield* prHubActionError(
            "This repository is archived. Its pull requests are read-only.",
          );
        const repository = pr.repository.nameWithOwner.toLowerCase();
        const excluded = (current: { prHub: { excludeRepos: readonly string[] } }) =>
          current.prHub.excludeRepos.some((repo) => repo.trim().toLowerCase() === repository);
        const denied = () =>
          new GitHubCliError({
            operation: "prHub.requestPolicy",
            kind: "forbidden",
            detail: "This PR is excluded or no longer writable. No further request will be sent.",
          });
        return yield* effect.pipe(
          Effect.provideService(GitHubRequestPolicy, {
            beforeSend: (write) =>
              Effect.gen(function* () {
                const current = yield* settings.getSettings.pipe(Effect.mapError(() => denied()));
                if (excluded(current)) return yield* denied();
                if (write) {
                  const latest = yield* trackedPrByKey(pr.key).pipe(
                    Effect.mapError(() => denied()),
                  );
                  if (latest.repositoryArchived || latest.state !== "open") return yield* denied();
                  const capture = yield* Effect.serviceOption(GitHubCredentialScope);
                  if (Option.isNone(capture)) return yield* denied();
                  const provider = yield* sourceControlProviders
                    .get(pr.provider)
                    .pipe(Effect.mapError(() => denied()));
                  const checked = yield* provider
                    .query({
                      cwd,
                      host: pr.host,
                      document: `query F5WritePolicy($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { isArchived viewerPermission pullRequest(number:$number) { id state viewerCanComment viewerCanUpdate baseRefName baseRefOid headRefOid mergeable mergeStateStatus reviewDecision ${PR_HUB_BRANCH_REQUIREMENTS_FIELDS}
                    commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { totalCount pageInfo { hasNextPage endCursor } nodes { ... on CheckRun { name conclusion status detailsUrl checkSuite { app { databaseId } } } ... on StatusContext { context state targetUrl } } } } } } }
                    reviewThreads(first:100) { totalCount pageInfo { hasNextPage endCursor } nodes { isResolved } }
                  } } }`,
                      variables: {
                        owner: pr.repository.owner,
                        name: pr.repository.repo,
                        number: pr.number,
                      },
                    })
                    .pipe(Effect.mapError(() => denied()));
                  const repo = asRecord(asRecord(asRecord(checked)?.data)?.repository);
                  const live = asRecord(repo?.pullRequest);
                  if (
                    !repo ||
                    repo.isArchived !== false ||
                    live?.state !== "OPEN" ||
                    (action === "update" || action === "merge"
                      ? live.viewerCanUpdate !== true
                      : live.viewerCanComment !== true)
                  )
                    return yield* denied();
                  const expected = input.expectedComparison;
                  if (
                    (action === "review" || action === "merge") &&
                    (live.headRefOid !== (expected?.headOid ?? pr.headRefOid) ||
                      live.baseRefName !== (expected?.baseRef ?? pr.baseRefName) ||
                      (expected && live.baseRefOid !== expected.baseOid))
                  )
                    return yield* new GitHubCliError({
                      operation: "prHub.requestPolicy",
                      kind: "forbidden",
                      detail:
                        "The PR comparison changed while this request was queued. Reload the submission preview.",
                    });
                  if (action === "merge" || action === "review") {
                    const requirements = yield* readMergeRequirements(
                      { ...live, repository: { nameWithOwner: pr.repository.nameWithOwner } },
                      (endpoint, query) =>
                        githubCli.request({
                          cwd,
                          context: capture.value,
                          method: "GET",
                          endpoint,
                          query,
                        }),
                    );
                    if (
                      action === "merge" &&
                      (requirements.verification !== "verified" ||
                        !requirements.mandatorySatisfied ||
                        live.reviewDecision !== "APPROVED" ||
                        !["WRITE", "MAINTAIN", "ADMIN"].includes(String(repo.viewerPermission)))
                    )
                      return yield* new GitHubCliError({
                        operation: "prHub.requestPolicy",
                        kind: "forbidden",
                        detail: requirements.explanation,
                      });
                  }
                  if (action === "merge" && expected) {
                    const comparison = yield* getFiles({ key: pr.key, mode: "force" }).pipe(
                      Effect.mapError(() => denied()),
                    );
                    if (!prComparisonsEqual(comparison.comparison, expected))
                      return yield* denied();
                  }
                  const currentAfterCheck = yield* settings.getSettings.pipe(
                    Effect.mapError(() => denied()),
                  );
                  if (excluded(currentAfterCheck)) return yield* denied();
                }
              }),
            readInvalidated: settings.streamChanges.pipe(
              Stream.filter(excluded),
              Stream.runHead,
              Effect.andThen(Effect.fail(denied())),
            ),
          }),
        );
      }),
      input.accountGeneration,
    );
  const withLocalAccount = <A, E>(
    effect: Effect.Effect<A, E>,
    generation: string,
  ): Effect.Effect<A, E | SourceControlProviderError> =>
    Effect.gen(function* () {
      const viewer = yield* Ref.get(viewerRef);
      if (viewer?.context.generation !== generation)
        return yield* prHubActionError(
          "The GitHub account changed. Refresh PR Hub before continuing.",
        );
      return yield* effect;
    });
  return {
    ...operations,
    claimNotifications: (input) =>
      withLocalAccount(operations.claimNotifications(input), input.accountGeneration),
    acknowledgeNotifications: (input) =>
      withLocalAccount(operations.acknowledgeNotifications(input), input.accountGeneration),
    clearData: (input) => withAccount(operations.clearData(input), input?.accountGeneration),
    track: (input) => withAccount(operations.track(input), input.accountGeneration),
    acknowledgeAttention: (input) =>
      withAccount(operations.acknowledgeAttention(input), input.accountGeneration),
    markSeen: (input) => withAccount(operations.markSeen(input), input.accountGeneration),
    markNotified: (input) => withAccount(operations.markNotified(input), input.accountGeneration),
    snooze: (input) => withAccount(operations.snooze(input), input.accountGeneration),
    unsnooze: (input) => withAccount(operations.unsnooze(input), input.accountGeneration),
    ignore: (input) => withAccount(operations.ignore(input), input.accountGeneration),
    approve: (input) => withPrAccount(operations.approve(input), input, true, "review"),
    requestChanges: (input) =>
      withPrAccount(operations.requestChanges(input), input, true, "review"),
    comment: (input) => withPrAccount(operations.comment(input), input),
    merge: (input) => withPrAccount(operations.merge(input), input, true, "merge"),
    markReady: (input) => withPrAccount(operations.markReady(input), input, true, "update"),
    reRequestReview: (input) =>
      withPrAccount(operations.reRequestReview(input), input, true, "update"),
    getDetail: (input) => withPrAccount(operations.getDetail(input), input, false),
    getTimeline: (input) => withPrAccount(operations.getTimeline(input), input, false),
    prepareComment: (input) => withPrAccount(operations.prepareComment(input), input, true),
    submitComment: (input) => withPrAccount(operations.submitComment(input), input, true),
    getCommentOperation: (input) =>
      withPrAccount(operations.getCommentOperation(input), input, false),
    recoverComment: (input) => withPrAccount(operations.recoverComment(input), input, false),
    prepareQuickReview: (input) => withPrAccount(operations.prepareQuickReview(input), input),
    prepareReview: (input) => withPrAccount(operations.prepareReview(input), input),
    submitReview: (input) => withPrAccount(operations.submitReview(input), input, true, "review"),
    getReviewOperation: (input) =>
      withPrAccount(operations.getReviewOperation(input), input, false),
    recoverReview: (input) => withPrAccount(operations.recoverReview(input), input, false),
    cancelReviewPreparation: (input) =>
      withPrAccount(operations.cancelReviewPreparation(input), input, false),
    replyReviewThread: (input) => withPrAccount(operations.replyReviewThread(input), input),
    recoverReply: (input) => withPrAccount(operations.recoverReply(input), input, false),
    getReplyDraft: (input) => withPrAccount(operations.getReplyDraft(input), input, false),
    saveReplyDraft: (input) => withPrAccount(operations.saveReplyDraft(input), input, false),
    getReplyOperation: (input) => withPrAccount(operations.getReplyOperation(input), input, false),
    getReviewThreads: (input) => withPrAccount(operations.getReviewThreads(input), input, false),
    setReviewThreadState: (input) => withPrAccount(operations.setReviewThreadState(input), input),
    getReviewDraft: (input) => withPrAccount(operations.getReviewDraft(input), input, false),
    saveReviewDraft: (input) => withPrAccount(operations.saveReviewDraft(input), input, false),
    getFiles: (input) => withPrAccount(operations.getFiles(input), input, false),
    getUnresolvedThreads: (input) =>
      withPrAccount(operations.getUnresolvedThreads(input), input, false),
    updateComment: (input) => withPrAccount(operations.updateComment(input), input),
    setReaction: (input) => withPrAccount(operations.setReaction(input), input),
    changeReviewers: (input) =>
      withPrAccount(operations.changeReviewers(input), input, true, "update"),
    updateBranch: (input) => withPrAccount(operations.updateBranch(input), input, true, "update"),
  } satisfies PrHubServiceShape;
});

export const PrHubServiceLive = Layer.effect(PrHubService, makePrHubService);
