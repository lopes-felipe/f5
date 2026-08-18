import os from "node:os";
import { createHash } from "node:crypto";

import {
  PullRequestKey,
  type PrHubDetailResult,
  type PrHubFilesPage,
  type PrAttentionBucket,
  type PrAttentionState,
  type PrCheckRollup,
  type PrHubLocalCheckoutCandidate,
  type PrHubRefreshInput,
  type PrHubSnapshot,
  type PrHubTimelineComment,
  type PrHubTimelinePage,
  type PrMergeable,
  type PrPullRequestState,
  type PrRepositoryRef,
  type PrReviewDecision,
  type PrViewerRole,
  type SourceControlHostAuthState,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { derivePrAttention } from "@t3tools/shared/prHub";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
  sourceControlPullRequestKeysEqual,
} from "@t3tools/shared/sourceControl";
import { Cause, Deferred, Effect, Exit, Layer, PubSub, Ref, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  GITHUB_SOURCE_CONTROL_CAPABILITIES,
  makeGitHubSourceControlProvider,
} from "../../sourceControl/GitHubSourceControlProvider.ts";
import {
  SourceControlProviderError,
  makeSourceControlProviderRegistry,
} from "../../sourceControl/SourceControlProvider.ts";
import { discoverSourceControlProviderIdentities } from "../../sourceControl/discovery.ts";
import { PrHubService, type PrHubServiceShape } from "../Services/PrHubService.ts";
import {
  decodeGitHubPrDetail,
  decodeGitHubPrFiles,
  decodeGitHubPrTimeline,
  GITHUB_ADD_REACTION_MUTATION,
  GITHUB_PR_DETAIL_QUERY,
  GITHUB_PR_FILES_QUERY,
  GITHUB_PR_TIMELINE_QUERY,
  GITHUB_REACTION_CONTENT,
  GITHUB_REMOVE_REACTION_MUTATION,
  githubTimelineVariables,
} from "../githubPrDetails.ts";

const DEFAULT_HOST = process.env.GH_HOST?.trim() || "github.com";
const SEARCH_SORT_QUALIFIER = "sort:updated-desc";
const SEARCH_OPEN_PREFIX = `is:pr is:open archived:false ${SEARCH_SORT_QUALIFIER}`;
const GRAPHQL_REVIEW_BUCKET_LIMIT = 30;
const GRAPHQL_BROAD_BUCKET_LIMIT = 20;
const TEAM_QUERY_CHUNK_SIZE = 10;
const TEAM_QUERY_CHUNK_COUNT = 5;
const PR_HUB_DETAILS_CHUNK_SIZE = 8;
const RECONCILE_NODE_CHUNK_SIZE = 50;
const RECONCILE_REPO_NUMBER_CHUNK_SIZE = 20;
const RESOLVED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const NO_LONGER_RELEVANT_RETENTION_MS = 48 * 60 * 60 * 1000;
const NO_MATCH_SEARCH_QUERY = `${SEARCH_OPEN_PREFIX} updated:<1970-01-02`;
const PR_DETAIL_CACHE_TTL_MS = 30_000;
const PR_DETAIL_CACHE_CAPACITY = 128;

interface ViewerIdentity {
  readonly login: string;
  readonly teams: ReadonlyArray<string>;
  readonly teamLookupError: string | null;
}

interface ViewerStateRow {
  readonly roles_json: string;
  readonly attention_fingerprint: string;
  readonly last_seen_fingerprint: string | null;
  readonly last_notified_fingerprint: string | null;
  readonly snoozed_until: string | null;
  readonly ignored_at: string | null;
  readonly no_longer_relevant_at: string | null;
}

interface PrDbRow {
  readonly provider_kind: "github";
  readonly host: string;
  readonly repo: string;
  readonly number: number;
  readonly node_id: string | null;
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  readonly state: PrPullRequestState;
  readonly draft: number;
  readonly check_rollup: PrCheckRollup;
  readonly review_decision: PrReviewDecision;
  readonly mergeable: PrMergeable;
  readonly merge_state_status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly payload_json: string;
  readonly roles_json: string;
  readonly attention_state: PrAttentionState;
  readonly attention_bucket: PrAttentionBucket;
  readonly primary_reason: string;
  readonly next_action: string;
  readonly attention_fingerprint: string;
  readonly last_seen_fingerprint: string | null;
  readonly last_notified_fingerprint: string | null;
  readonly snoozed_until: string | null;
  readonly ignored_at: string | null;
  readonly no_longer_relevant_at: string | null;
}

interface RefreshStateRow {
  readonly viewer_login: string;
  readonly status: PrHubSnapshot["status"];
  readonly last_polled_at: string | null;
  readonly error_kind: string | null;
  readonly error_message: string | null;
  readonly capped_buckets_json: string | null;
}

interface NormalizedPr {
  readonly nodeId: string | null;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repository: PrRepositoryRef;
  readonly host: string;
  readonly author: string | null;
  readonly isDraft: boolean;
  readonly state: PrPullRequestState;
  readonly checkRollup: PrCheckRollup;
  readonly reviewDecision: PrReviewDecision;
  readonly mergeable: PrMergeable;
  readonly mergeStateStatus: string;
  readonly viewerHasReviewed: boolean;
  readonly viewerReviewRequested: boolean;
  readonly reviewRequestReviewers: ReadonlyArray<string>;
  readonly reviewRequestsCount: number;
  readonly commentsCount: number;
  readonly unresolvedThreadCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly headRefOid: string | null;
  readonly baseRefName: string | null;
  readonly headRefName: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly roles: ReadonlyArray<PrViewerRole>;
}

interface FetchResult {
  readonly pullRequests: ReadonlyArray<NormalizedPr>;
  readonly cappedBuckets: ReadonlyArray<string>;
  readonly degraded: boolean;
  readonly errorMessage?: string | undefined;
}

interface ReconciledPrState {
  readonly nodeId: string | null;
  readonly state: "closed" | "merged";
  readonly closedAt: string;
  readonly updatedAt: string;
}

type ReconcilePolicy = "authoritative" | "terminal_only";

interface PersistedPrRow {
  readonly repo: string;
  readonly number: number;
  readonly node_id: string | null;
  readonly stale_inaccessible_count: number;
  readonly payload_json: string;
}

interface ReconcileByNumberRequest {
  readonly query: string;
  readonly variables: Record<string, string | number>;
  readonly aliases: ReadonlyArray<{
    readonly alias: string;
    readonly key: string;
  }>;
}

interface CachedPrDetailRead<A> {
  readonly value: A;
  readonly storedAt: number;
}

interface PrDetailReadMetadata {
  readonly stale: boolean;
  readonly refreshedAt: string;
  readonly warning?: string | undefined;
}

function cacheSet<A>(cache: Map<string, CachedPrDetailRead<A>>, key: string, value: A): void {
  cache.delete(key);
  cache.set(key, { value, storedAt: Date.now() });
  while (cache.size > PR_DETAIL_CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function isRetainableDetailFailure(error: SourceControlProviderError): boolean {
  return error.kind === "network" || error.kind === "timeout" || error.kind === "rate_limited";
}

function readPrDetailCache<A extends PrDetailReadMetadata>(input: {
  readonly cache: Map<string, CachedPrDetailRead<A>>;
  readonly key: string;
  readonly mode: "if_stale" | "force";
  readonly fetch: Effect.Effect<A, SourceControlProviderError>;
}): Effect.Effect<A, SourceControlProviderError> {
  const cached = input.cache.get(input.key);
  if (
    input.mode === "if_stale" &&
    cached &&
    Date.now() - cached.storedAt < PR_DETAIL_CACHE_TTL_MS
  ) {
    input.cache.delete(input.key);
    input.cache.set(input.key, cached);
    return Effect.succeed(cached.value);
  }
  return input.fetch.pipe(
    Effect.tap((value) => Effect.sync(() => cacheSet(input.cache, input.key, value))),
    Effect.catch((error) =>
      cached && isRetainableDetailFailure(error)
        ? Effect.succeed({
            ...cached.value,
            stale: true,
            warning: error.detail,
          })
        : Effect.fail(error),
    ),
  );
}

function accountCwd(fallback: string): string {
  const home = os.homedir();
  return home && home.trim().length > 0 ? home : fallback;
}

function emptySnapshot(input?: {
  readonly host?: string;
  readonly viewerLogin?: string | null;
  readonly status?: PrHubSnapshot["status"];
  readonly errorKind?: string | undefined;
  readonly errorMessage?: string | undefined;
}): PrHubSnapshot {
  const host = input?.host ?? DEFAULT_HOST;
  const viewerLogin = input?.viewerLogin ?? null;
  const status = input?.status ?? "ok";
  return {
    status,
    viewerLogin,
    host,
    authStates: [githubAuthState({ ...input, host, viewerLogin, status })],
    pullRequests: [],
    recentlyResolved: [],
    lastPolledAt: null,
    ...(input?.errorKind ? { errorKind: input.errorKind } : {}),
    ...(input?.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

function githubAuthState(input: {
  readonly host: string;
  readonly viewerLogin: string | null;
  readonly status: PrHubSnapshot["status"];
  readonly errorKind?: string | undefined;
  readonly errorMessage?: string | undefined;
}): SourceControlHostAuthState {
  const status = (() => {
    switch (input.status) {
      case "ok":
        return "ok" as const;
      case "auth_required":
        return "auth-required" as const;
      case "gh_missing":
        return "provider-missing" as const;
      case "degraded":
        return "degraded" as const;
      case "error":
        return "error" as const;
    }
  })();
  return {
    provider: "github",
    host: input.host,
    status,
    viewerLogin: input.viewerLogin,
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorDetail(value: unknown): string | null {
  const record = asRecord(value);
  const detail = record ? stringValue(record.detail) : null;
  if (detail) return detail;
  return null;
}

function causeUserMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  return errorDetail(Cause.squash(cause)) ?? fallback;
}

function causeErrorKind(cause: Cause.Cause<unknown>): string | null {
  return stringValue(asRecord(Cause.squash(cause))?.kind);
}

function shouldSplitDetailChunk(cause: Cause.Cause<unknown>): boolean {
  const kind = causeErrorKind(cause);
  return kind === null || kind === "generic" || kind === "network" || kind === "timeout";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parsePayload(value: string): Partial<TrackedPullRequest> {
  try {
    const parsed = JSON.parse(value);
    return (asRecord(parsed) as Partial<TrackedPullRequest> | null) ?? {};
  } catch {
    return {};
  }
}

function repositoryFromNameWithOwner(nameWithOwner: string): PrRepositoryRef {
  const [owner = "", ...repoParts] = nameWithOwner.split("/");
  const repo = repoParts.join("/");
  return {
    owner,
    repo,
    nameWithOwner: `${owner}/${repo}`,
  };
}

function parseRepositoryNameWithOwner(
  nameWithOwner: string,
): { readonly owner: string; readonly name: string } | null {
  const [owner = "", ...nameParts] = nameWithOwner.split("/");
  const name = nameParts.join("/");
  return owner.length > 0 && name.length > 0 ? { owner, name } : null;
}

function keyFor(host: string, repo: string, number: number): PullRequestKey {
  return formatSourceControlPullRequestKey({
    provider: "github",
    host,
    repository: repo,
    number,
  });
}

function githubProviderFields(input: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly nodeId: string | null;
  readonly reviewDecision: PrReviewDecision;
  readonly mergeStateStatus: string;
}) {
  return {
    provider: "github" as const,
    ref: {
      provider: "github" as const,
      host: input.host,
      repository: input.repository,
      number: input.number,
    },
    capabilities: [...GITHUB_SOURCE_CONTROL_CAPABILITIES],
    providerDetails: {
      provider: "github" as const,
      nodeId: input.nodeId,
      reviewDecision: input.reviewDecision,
      mergeStateStatus: input.mergeStateStatus,
    },
  };
}

function normalizePullRequestState(value: unknown): PrPullRequestState {
  switch (stringValue(value)?.toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

function normalizeTerminalPullRequestState(
  node: Record<string, unknown>,
): ReconciledPrState | null {
  const nodeId = stringValue(node.id);
  const rawState = stringValue(node.state)?.toUpperCase();
  const mergedAt = stringValue(node.mergedAt);
  const closedAt = stringValue(node.closedAt);
  const updatedAt = stringValue(node.updatedAt) ?? closedAt ?? mergedAt ?? new Date().toISOString();
  if (rawState === "MERGED" || mergedAt) {
    return {
      nodeId,
      state: "merged",
      closedAt: mergedAt ?? closedAt ?? updatedAt,
      updatedAt,
    };
  }
  if (rawState === "CLOSED") {
    return {
      nodeId,
      state: "closed",
      closedAt: closedAt ?? updatedAt,
      updatedAt,
    };
  }
  return null;
}

function terminalAttention(state: ReconciledPrState["state"]): {
  readonly attentionState: PrAttentionState;
  readonly attentionBucket: PrAttentionBucket;
  readonly primaryReason: string;
  readonly nextAction: string;
} {
  if (state === "merged") {
    return {
      attentionState: "merged",
      attentionBucket: "informational",
      primaryReason: "Merged",
      nextAction: "Merged",
    };
  }
  return {
    attentionState: "closed",
    attentionBucket: "informational",
    primaryReason: "Closed",
    nextAction: "Closed without merge",
  };
}

function terminalFingerprint(input: {
  readonly host: string;
  readonly repo: string;
  readonly number: number;
  readonly state: ReconciledPrState["state"];
  readonly updatedAt: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        key: `${input.host}/${input.repo}#${input.number}`,
        attentionState: input.state,
        updatedAt: input.updatedAt,
      }),
    )
    .digest("hex");
}

function normalizeCheckRollup(value: unknown): PrCheckRollup {
  switch (stringValue(value)?.toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "FAILURE_OR_ERROR":
      return "failure";
    case "ERROR":
      return "error";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function normalizeReviewDecision(value: unknown): PrReviewDecision {
  switch (stringValue(value)?.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

function normalizeMergeable(value: unknown): PrMergeable {
  switch (stringValue(value)?.toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function statusCheckState(node: Record<string, unknown>): unknown {
  const commits = asRecord(node.commits);
  const firstCommitNode = asRecord(asArray(commits?.nodes)[0]);
  const commit = asRecord(firstCommitNode?.commit);
  return asRecord(commit?.statusCheckRollup)?.state;
}

function nodeArray(connection: unknown): Record<string, unknown>[] {
  return asArray(asRecord(connection)?.nodes)
    .map(asRecord)
    .filter((node): node is Record<string, unknown> => node !== null);
}

function labels(node: Record<string, unknown>): string[] {
  return nodeArray(node.labels)
    .map((label) => stringValue(label.name))
    .filter((label): label is string => label !== null);
}

function assignees(node: Record<string, unknown>): string[] {
  return nodeArray(node.assignees)
    .map((assignee) => stringValue(assignee.login))
    .filter((assignee): assignee is string => assignee !== null);
}

function unresolvedThreadCount(node: Record<string, unknown>): number {
  return nodeArray(node.reviewThreads).filter((thread) => thread.isResolved !== true).length;
}

function reviewRequestReviewers(node: Record<string, unknown>): string[] {
  return nodeArray(node.reviewRequests)
    .map((request) => asRecord(request.requestedReviewer))
    .filter((reviewer): reviewer is Record<string, unknown> => reviewer !== null)
    .map((reviewer) => stringValue(reviewer.login) ?? stringValue(reviewer.combinedSlug))
    .filter((reviewer): reviewer is string => reviewer !== null);
}

function viewerHasReviewed(node: Record<string, unknown>, viewerLogin: string): boolean {
  return nodeArray(node.latestReviews).some((review) => {
    const author = asRecord(review.author);
    const login = stringValue(author?.login);
    const state = stringValue(review.state)?.toUpperCase();
    return (
      login?.toLowerCase() === viewerLogin.toLowerCase() &&
      state !== null &&
      state !== "PENDING" &&
      state !== "DISMISSED"
    );
  });
}

function attentionFingerprint(pr: NormalizedPr, attentionState: PrAttentionState): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        key: `${pr.host}/${pr.repository.nameWithOwner}#${pr.number}`,
        attentionState,
        checkRollup: pr.checkRollup,
        reviewDecision: pr.reviewDecision,
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus,
        headRefOid: pr.headRefOid,
        viewerReviewRequested: pr.viewerReviewRequested,
        unresolvedThreadCount: pr.unresolvedThreadCount,
      }),
    )
    .digest("hex");
}

function isSnoozed(snoozedUntil: string | null): boolean {
  if (!snoozedUntil) return false;
  const timestamp = new Date(snoozedUntil).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function normalizeRoles(roles: Iterable<PrViewerRole>): PrViewerRole[] {
  const order: PrViewerRole[] = [
    "author",
    "review_requested",
    "team_review_requested",
    "assignee",
    "mentioned",
    "involved",
  ];
  const roleSet = new Set(roles);
  return order.filter((role) => roleSet.has(role));
}

function sortTrackedPrs(prs: ReadonlyArray<TrackedPullRequest>): TrackedPullRequest[] {
  const bucketRank: Record<PrAttentionBucket, number> = {
    needs_you: 0,
    waiting_on_others: 1,
    informational: 2,
  };
  return [...prs].sort(
    (left, right) =>
      bucketRank[left.attentionBucket] - bucketRank[right.attentionBucket] ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.key.localeCompare(left.key),
  );
}

function buildTrackedPullRequest(
  pr: NormalizedPr,
  viewerLogin: string,
  previous: ViewerStateRow | undefined,
): TrackedPullRequest {
  const derivation = derivePrAttention({
    author: pr.author,
    isAuthor: pr.author?.toLowerCase() === viewerLogin.toLowerCase(),
    isDraft: pr.isDraft,
    state: pr.state,
    checkRollup: pr.checkRollup,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    viewerHasReviewed: pr.viewerHasReviewed,
    viewerReviewRequested: pr.viewerReviewRequested,
    roles: pr.roles,
  });
  const fingerprint = attentionFingerprint(pr, derivation.attentionState);
  const snoozedUntil = previous?.snoozed_until ?? null;
  const ignoredAt = previous?.ignored_at ?? null;
  const snoozed = isSnoozed(snoozedUntil);
  const lastNotified = previous?.last_notified_fingerprint ?? null;
  const lastSeen = previous?.last_seen_fingerprint ?? null;
  const notificationPending =
    derivation.attentionBucket === "needs_you" &&
    !snoozed &&
    ignoredAt === null &&
    fingerprint !== lastNotified &&
    fingerprint !== lastSeen;

  return {
    key: keyFor(pr.host, pr.repository.nameWithOwner, pr.number),
    ...githubProviderFields({
      host: pr.host,
      repository: pr.repository.nameWithOwner,
      number: pr.number,
      nodeId: pr.nodeId,
      reviewDecision: pr.reviewDecision,
      mergeStateStatus: pr.mergeStateStatus,
    }),
    nodeId: pr.nodeId,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repository: pr.repository,
    host: pr.host,
    author: pr.author,
    isDraft: pr.isDraft,
    state: pr.state,
    roles: [...pr.roles],
    attentionState: derivation.attentionState,
    attentionBucket: derivation.attentionBucket,
    primaryReason: derivation.primaryReason,
    nextAction: derivation.nextAction,
    checkRollup: pr.checkRollup,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    viewerHasReviewed: pr.viewerHasReviewed,
    viewerReviewRequested: pr.viewerReviewRequested,
    reviewRequestReviewers: [...pr.reviewRequestReviewers],
    reviewRequestsCount: pr.reviewRequestsCount,
    commentsCount: pr.commentsCount,
    unresolvedThreadCount: pr.unresolvedThreadCount,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    labels: [...pr.labels],
    assignees: [...pr.assignees],
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    snoozedUntil,
    ignoredAt,
    notificationPending,
    attentionFingerprint: fingerprint,
  };
}

function normalizeGraphqlPr(input: {
  readonly node: Record<string, unknown>;
  readonly aliases: ReadonlySet<string>;
  readonly host: string;
  readonly viewerLogin: string;
  readonly viewerTeams: ReadonlySet<string>;
}): NormalizedPr | null {
  const repositoryNode = asRecord(input.node.repository);
  const nameWithOwner = stringValue(repositoryNode?.nameWithOwner);
  const number = numberValue(input.node.number);
  const title = stringValue(input.node.title);
  const url = stringValue(input.node.url);
  if (!nameWithOwner || number <= 0 || !title || !url) return null;

  const authorLogin = stringValue(asRecord(input.node.author)?.login);
  const reviewRequests = reviewRequestReviewers(input.node);
  const viewerLoginLower = input.viewerLogin.toLowerCase();
  const viewerTeamLower = new Set([...input.viewerTeams].map((team) => team.toLowerCase()));
  const directReviewRequested = reviewRequests.some(
    (reviewer) => reviewer.toLowerCase() === viewerLoginLower,
  );
  const teamReviewRequested = reviewRequests.some((reviewer) =>
    viewerTeamLower.has(reviewer.toLowerCase()),
  );
  const roleSet = new Set<PrViewerRole>();
  if (input.aliases.has("author") || authorLogin?.toLowerCase() === viewerLoginLower) {
    roleSet.add("author");
  }
  if (input.aliases.has("review_requested") || directReviewRequested) {
    roleSet.add("review_requested");
  }
  if (input.aliases.has("team_review") || teamReviewRequested) {
    roleSet.add("team_review_requested");
  }
  if (input.aliases.has("assignee")) roleSet.add("assignee");
  if (input.aliases.has("mentioned")) roleSet.add("mentioned");
  if (input.aliases.has("involved")) roleSet.add("involved");

  return {
    nodeId: stringValue(input.node.id),
    number,
    title,
    url,
    repository: repositoryFromNameWithOwner(nameWithOwner),
    host: input.host,
    author: authorLogin,
    isDraft: booleanValue(input.node.isDraft),
    state: normalizePullRequestState(input.node.state),
    checkRollup: normalizeCheckRollup(statusCheckState(input.node)),
    reviewDecision: normalizeReviewDecision(input.node.reviewDecision),
    mergeable: normalizeMergeable(input.node.mergeable),
    mergeStateStatus: stringValue(input.node.mergeStateStatus)?.toUpperCase() ?? "UNKNOWN",
    viewerHasReviewed: viewerHasReviewed(input.node, input.viewerLogin),
    viewerReviewRequested:
      input.aliases.has("review_requested") ||
      input.aliases.has("team_review") ||
      directReviewRequested ||
      teamReviewRequested,
    reviewRequestReviewers: reviewRequests,
    reviewRequestsCount: reviewRequests.length,
    commentsCount: numberValue(asRecord(input.node.comments)?.totalCount),
    unresolvedThreadCount: unresolvedThreadCount(input.node),
    additions: numberValue(input.node.additions),
    deletions: numberValue(input.node.deletions),
    changedFiles: numberValue(input.node.changedFiles),
    headRefOid: stringValue(input.node.headRefOid),
    baseRefName: stringValue(input.node.baseRefName),
    headRefName: stringValue(input.node.headRefName),
    labels: labels(input.node),
    assignees: assignees(input.node),
    createdAt: stringValue(input.node.createdAt) ?? new Date().toISOString(),
    updatedAt: stringValue(input.node.updatedAt) ?? new Date().toISOString(),
    closedAt: stringValue(input.node.closedAt),
    roles: normalizeRoles(roleSet),
  };
}

function normalizeFallbackPr(input: {
  readonly node: Record<string, unknown>;
  readonly aliases: ReadonlySet<string>;
  readonly host: string;
  readonly viewerLogin: string;
}): NormalizedPr | null {
  const repoNode = asRecord(input.node.repository);
  const nameWithOwner =
    stringValue(repoNode?.nameWithOwner) ??
    [stringValue(repoNode?.owner), stringValue(repoNode?.name)].filter(Boolean).join("/");
  const number = numberValue(input.node.number);
  const title = stringValue(input.node.title);
  const url = stringValue(input.node.url);
  if (!nameWithOwner || number <= 0 || !title || !url) return null;
  const authorLogin = stringValue(asRecord(input.node.author)?.login);
  const roleSet = new Set<PrViewerRole>();
  if (
    input.aliases.has("author") ||
    authorLogin?.toLowerCase() === input.viewerLogin.toLowerCase()
  ) {
    roleSet.add("author");
  }
  if (input.aliases.has("review_requested")) roleSet.add("review_requested");
  if (input.aliases.has("assignee")) roleSet.add("assignee");
  if (input.aliases.has("mentioned")) roleSet.add("mentioned");
  if (input.aliases.has("involved")) roleSet.add("involved");

  return {
    nodeId: null,
    number,
    title,
    url,
    repository: repositoryFromNameWithOwner(nameWithOwner),
    host: input.host,
    author: authorLogin,
    isDraft: booleanValue(input.node.isDraft),
    state: normalizePullRequestState(input.node.state),
    checkRollup: "pending",
    reviewDecision: "none",
    mergeable: "unknown",
    mergeStateStatus: "UNKNOWN",
    viewerHasReviewed: false,
    viewerReviewRequested: input.aliases.has("review_requested"),
    reviewRequestReviewers: [],
    reviewRequestsCount: input.aliases.has("review_requested") ? 1 : 0,
    commentsCount: numberValue(input.node.commentsCount),
    unresolvedThreadCount: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: null,
    baseRefName: null,
    headRefName: null,
    labels: [],
    assignees: assignees(input.node),
    createdAt: stringValue(input.node.createdAt) ?? new Date().toISOString(),
    updatedAt: stringValue(input.node.updatedAt) ?? new Date().toISOString(),
    closedAt: null,
    roles: normalizeRoles(roleSet),
  };
}

function chunkedTeamReviewQueries(teams: ReadonlyArray<string>): string[] {
  const normalizedTeams = teams.map((team) => team.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (let index = 0; index < TEAM_QUERY_CHUNK_COUNT; index += 1) {
    const chunk = normalizedTeams.slice(
      index * TEAM_QUERY_CHUNK_SIZE,
      (index + 1) * TEAM_QUERY_CHUNK_SIZE,
    );
    chunks.push(
      chunk.length > 0
        ? `${SEARCH_OPEN_PREFIX} (${chunk.map((team) => `team-review-requested:${team}`).join(" OR ")})`
        : NO_MATCH_SEARCH_QUERY,
    );
  }
  return chunks;
}

function buildSearchQueries(login: string, teams: ReadonlyArray<string>) {
  const updatedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const teamQueries = chunkedTeamReviewQueries(teams);
  return {
    rr: `${SEARCH_OPEN_PREFIX} review-requested:${login}`,
    tr0: teamQueries[0] ?? NO_MATCH_SEARCH_QUERY,
    tr1: teamQueries[1] ?? NO_MATCH_SEARCH_QUERY,
    tr2: teamQueries[2] ?? NO_MATCH_SEARCH_QUERY,
    tr3: teamQueries[3] ?? NO_MATCH_SEARCH_QUERY,
    tr4: teamQueries[4] ?? NO_MATCH_SEARCH_QUERY,
    au: `${SEARCH_OPEN_PREFIX} author:${login}`,
    as: `${SEARCH_OPEN_PREFIX} assignee:${login}`,
    me: `${SEARCH_OPEN_PREFIX} mentions:${login}`,
    inv: `${SEARCH_OPEN_PREFIX} involves:${login}`,
    closed: `is:pr -is:open author:${login} updated:>=${updatedSince} archived:false ${SEARCH_SORT_QUALIFIER}`,
  };
}

const PR_HUB_SEARCH_QUERY = `
query PrHubSearch($rr:String!,$tr0:String!,$tr1:String!,$tr2:String!,$tr3:String!,$tr4:String!,$au:String!,$as:String!,$me:String!,$inv:String!,$closed:String!){
  review_requested: search(query:$rr,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  team_review_0: search(query:$tr0,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  team_review_1: search(query:$tr1,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  team_review_2: search(query:$tr2,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  team_review_3: search(query:$tr3,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  team_review_4: search(query:$tr4,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  author: search(query:$au,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  assignee: search(query:$as,type:ISSUE,first:30){ issueCount nodes{ ...PrSearchFields } }
  mentioned: search(query:$me,type:ISSUE,first:20){ issueCount nodes{ ...PrSearchFields } }
  involved: search(query:$inv,type:ISSUE,first:20){ issueCount nodes{ ...PrSearchFields } }
  recently_closed: search(query:$closed,type:ISSUE,first:20){ issueCount nodes{ ...PrSearchFields } }
}
fragment PrSearchFields on PullRequest {
  id
}
`;

const PR_HUB_DETAILS_QUERY = `
query PrHubDetails($ids:[ID!]!){
  nodes(ids:$ids){
    ... on PullRequest {
      ...PrFields
    }
  }
}
fragment PrFields on PullRequest {
  id
  number
  title
  url
  state
  isDraft
  mergeable
  reviewDecision
  mergeStateStatus
  createdAt
  updatedAt
  closedAt
  baseRefName
  headRefName
  headRefOid
  additions
  deletions
  changedFiles
  author { login }
  repository { nameWithOwner isPrivate }
  labels(first:10){ nodes { name } }
  assignees(first:10){ nodes { login } }
  comments { totalCount }
  reviewThreads(first:50){ nodes { isResolved } }
  reviewRequests(first:20){ nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  latestReviews(first:50){ nodes { author { login } state } }
  commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
}
`;

const PR_HUB_RECONCILE_QUERY = `
query PrHubReconcile($ids:[ID!]!){
  nodes(ids:$ids){
    ... on PullRequest {
      id
      state
      closedAt
      mergedAt
      updatedAt
    }
  }
}
`;

function buildReconcileByNumberRequest(
  targets: ReadonlyArray<Pick<PersistedPrRow, "repo" | "number">>,
): ReconcileByNumberRequest | null {
  const variableDefinitions: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};
  const aliases: Array<ReconcileByNumberRequest["aliases"][number]> = [];

  for (const target of targets) {
    const repository = parseRepositoryNameWithOwner(target.repo);
    if (!repository) continue;
    const index = aliases.length;
    const alias = `pr${index}`;
    variableDefinitions.push(
      `$owner${index}:String!`,
      `$name${index}:String!`,
      `$number${index}:Int!`,
    );
    variables[`owner${index}`] = repository.owner;
    variables[`name${index}`] = repository.name;
    variables[`number${index}`] = target.number;
    selections.push(
      `${alias}: repository(owner:$owner${index},name:$name${index}){ pullRequest(number:$number${index}){ ...PrHubTerminalFields } }`,
    );
    aliases.push({ alias, key: `${target.repo}#${target.number}` });
  }

  if (aliases.length === 0) return null;
  return {
    query: `
query PrHubReconcileByNumber(${variableDefinitions.join(",")}){
  ${selections.join("\n  ")}
}
fragment PrHubTerminalFields on PullRequest {
  id
  state
  closedAt
  mergedAt
  updatedAt
}
`,
    variables,
    aliases,
  };
}

const makePrHubService = Effect.gen(function* () {
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
  const snapshotPubSub = yield* PubSub.unbounded<PrHubSnapshot>();
  const actionRefreshPubSub = yield* PubSub.unbounded<void>();
  const inFlightRef = yield* Ref.make<Deferred.Deferred<PrHubSnapshot> | null>(null);
  const viewerRef = yield* Ref.make<ViewerIdentity | null>(null);
  const detailCache = new Map<string, CachedPrDetailRead<PrHubDetailResult>>();
  const timelineCache = new Map<string, CachedPrDetailRead<PrHubTimelinePage>>();
  const filesCache = new Map<string, CachedPrDetailRead<PrHubFilesPage>>();

  const publishSnapshot = (snapshot: PrHubSnapshot) =>
    Ref.set(snapshotRef, snapshot).pipe(
      Effect.andThen(PubSub.publish(snapshotPubSub, snapshot)),
      Effect.as(snapshot),
    );

  const loadRefreshState = (viewerLogin?: string | null) =>
    Effect.gen(function* () {
      if (viewerLogin) {
        const rows = yield* sql<RefreshStateRow>`
          SELECT
            viewer_login,
            status,
            last_polled_at,
            error_kind,
            error_message,
            capped_buckets_json
          FROM pr_hub_refresh_state
          WHERE provider_kind = ${providerKind}
            AND host = ${host}
            AND viewer_login = ${viewerLogin}
          LIMIT 1
        `;
        return rows[0] ?? null;
      }

      const rows = yield* sql<RefreshStateRow>`
      SELECT
        viewer_login,
        status,
        last_polled_at,
        error_kind,
        error_message,
        capped_buckets_json
      FROM pr_hub_refresh_state
      WHERE provider_kind = ${providerKind}
        AND host = ${host}
      ORDER BY COALESCE(last_polled_at, '') DESC
      LIMIT 1
    `;
      return rows[0] ?? null;
    });

  const viewerStateMap = (viewerLogin: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<ViewerStateRow & { readonly repo: string; readonly number: number }>`
        SELECT
          repo,
          number,
          roles_json,
          attention_fingerprint,
          last_seen_fingerprint,
          last_notified_fingerprint,
          snoozed_until,
          ignored_at,
          no_longer_relevant_at
        FROM pr_hub_viewer_state
        WHERE provider_kind = ${providerKind}
          AND host = ${host}
          AND viewer_login = ${viewerLogin}
      `;
      return new Map(rows.map((row) => [`${row.repo}#${row.number}`, row] as const));
    });

  const hydrateSnapshot = (viewerLogin?: string | null): Effect.Effect<PrHubSnapshot> =>
    Effect.gen(function* () {
      const refresh = yield* loadRefreshState(viewerLogin);
      const resolvedViewer = viewerLogin ?? refresh?.viewer_login ?? null;
      if (!resolvedViewer) return emptySnapshot({ host });

      const rows = yield* sql<PrDbRow>`
        SELECT
          p.provider_kind,
          p.host,
          p.repo,
          p.number,
          p.node_id,
          p.title,
          p.url,
          p.author,
          p.state,
          p.draft,
          p.check_rollup,
          p.review_decision,
          p.mergeable,
          p.merge_state_status,
          p.additions,
          p.deletions,
          p.changed_files,
          p.created_at,
          p.updated_at,
          p.payload_json,
          v.roles_json,
          v.attention_state,
          v.attention_bucket,
          v.primary_reason,
          v.next_action,
          v.attention_fingerprint,
          v.last_seen_fingerprint,
          v.last_notified_fingerprint,
          v.snoozed_until,
          v.ignored_at,
          v.no_longer_relevant_at
        FROM pr_hub_viewer_state v
        INNER JOIN pr_hub_prs p
          ON p.provider_kind = v.provider_kind
          AND p.host = v.host
          AND p.repo = v.repo
          AND p.number = v.number
        WHERE v.provider_kind = ${providerKind}
          AND v.host = ${host}
          AND v.viewer_login = ${resolvedViewer}
      `;

      const tracked = rows.map((row) => {
        const payload = parsePayload(row.payload_json);
        const roles = parseJsonArray(row.roles_json) as PrViewerRole[];
        const fingerprint = row.attention_fingerprint;
        const snoozedUntil = row.snoozed_until;
        const ignoredAt = row.ignored_at;
        const notificationPending =
          row.attention_bucket === "needs_you" &&
          !isSnoozed(snoozedUntil) &&
          ignoredAt === null &&
          fingerprint !== row.last_notified_fingerprint &&
          fingerprint !== row.last_seen_fingerprint;
        return {
          ...payload,
          key: keyFor(row.host, row.repo, row.number),
          ...githubProviderFields({
            host: row.host,
            repository: row.repo,
            number: row.number,
            nodeId: row.node_id,
            reviewDecision: row.review_decision,
            mergeStateStatus: row.merge_state_status,
          }),
          nodeId: row.node_id,
          number: row.number,
          title: row.title,
          url: row.url,
          repository: repositoryFromNameWithOwner(row.repo),
          host: row.host,
          author: row.author,
          isDraft: row.draft === 1,
          state: row.state,
          roles,
          attentionState: row.attention_state,
          attentionBucket: row.attention_bucket,
          primaryReason: row.primary_reason,
          nextAction: row.next_action,
          checkRollup: row.check_rollup,
          reviewDecision: row.review_decision,
          mergeable: row.mergeable,
          mergeStateStatus: row.merge_state_status,
          viewerHasReviewed: payload.viewerHasReviewed ?? false,
          viewerReviewRequested: payload.viewerReviewRequested ?? false,
          reviewRequestReviewers: payload.reviewRequestReviewers ?? [],
          reviewRequestsCount: payload.reviewRequestsCount ?? 0,
          commentsCount: payload.commentsCount ?? 0,
          unresolvedThreadCount: payload.unresolvedThreadCount ?? 0,
          additions: row.additions,
          deletions: row.deletions,
          changedFiles: row.changed_files,
          headRefOid: payload.headRefOid ?? null,
          baseRefName: payload.baseRefName ?? null,
          headRefName: payload.headRefName ?? null,
          labels: payload.labels ?? [],
          assignees: payload.assignees ?? [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          snoozedUntil,
          ignoredAt,
          notificationPending,
          attentionFingerprint: fingerprint,
        } satisfies TrackedPullRequest;
      });

      const pullRequests = tracked.filter(
        (pr) =>
          pr.state === "open" &&
          pr.ignoredAt === null &&
          rows.find((row) => row.repo === pr.repository.nameWithOwner && row.number === pr.number)
            ?.no_longer_relevant_at === null,
      );
      const recentlyResolved = tracked.filter(
        (pr) => pr.state === "closed" || pr.state === "merged" || pr.ignoredAt !== null,
      );
      return {
        status: refresh?.status ?? "ok",
        viewerLogin: resolvedViewer,
        host,
        authStates: [
          githubAuthState({
            host,
            viewerLogin: resolvedViewer,
            status: refresh?.status ?? "ok",
            ...(refresh?.error_kind ? { errorKind: refresh.error_kind } : {}),
            ...(refresh?.error_message ? { errorMessage: refresh.error_message } : {}),
          }),
        ],
        pullRequests: sortTrackedPrs(pullRequests),
        recentlyResolved: sortTrackedPrs(recentlyResolved),
        lastPolledAt: refresh?.last_polled_at ?? null,
        ...(refresh?.error_kind ? { errorKind: refresh.error_kind } : {}),
        ...(refresh?.error_message ? { errorMessage: refresh.error_message } : {}),
        ...(refresh?.capped_buckets_json
          ? { cappedBuckets: parseJsonArray(refresh.capped_buckets_json) }
          : {}),
      } satisfies PrHubSnapshot;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to hydrate PR Hub snapshot", {
          error: String(error),
        }).pipe(
          Effect.as(
            emptySnapshot({
              host,
              viewerLogin: viewerLogin ?? null,
              status: "error",
              errorKind: "error",
              errorMessage: "Could not load persisted PR Hub data.",
            }),
          ),
        ),
      ),
    );

  const getSnapshot = Ref.get(snapshotRef).pipe(
    Effect.flatMap((snapshot) => {
      if (snapshot) return Effect.succeed(snapshot);
      return Effect.exit(resolveViewer).pipe(
        Effect.flatMap((viewerExit) => {
          if (Exit.isSuccess(viewerExit)) {
            return hydrateSnapshot(viewerExit.value.login).pipe(Effect.flatMap(publishSnapshot));
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

  const resolveViewer = Effect.gen(function* () {
    const login = yield* github.getAuthenticatedLogin({ cwd });
    const cached = yield* Ref.get(viewerRef);
    if (cached?.login === login) return cached;
    const teamsExit = yield* Effect.exit(github.getViewerTeams({ cwd }));
    const teams = Exit.isSuccess(teamsExit) ? teamsExit.value : [];
    const teamLookupError = Exit.isFailure(teamsExit)
      ? causeUserMessage(teamsExit.cause, "Failed to load GitHub team memberships.")
      : null;
    if (teamLookupError) {
      yield* Effect.logWarning("failed to load GitHub viewer teams for PR Hub", {
        detail: teamLookupError,
      });
    }
    const viewer = { login, teams, teamLookupError };
    yield* Ref.set(viewerRef, viewer);
    return viewer;
  });

  const fetchGraphqlDetails = (
    nodeIds: ReadonlyArray<string>,
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
        yield* hydrateChunk(ids);
      }

      return {
        nodesById,
        degraded,
        ...(errorMessage ? { errorMessage } : {}),
      };
    });

  const fetchGraphql = (viewer: ViewerIdentity): Effect.Effect<FetchResult, never> =>
    Effect.gen(function* () {
      const queries = buildSearchQueries(viewer.login, viewer.teams);
      const teamListCapped = viewer.teams.length > TEAM_QUERY_CHUNK_SIZE * TEAM_QUERY_CHUNK_COUNT;
      const result = yield* Effect.exit(
        github.query({
          cwd,
          document: PR_HUB_SEARCH_QUERY,
          variables: queries,
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
        const limit =
          alias === "mentioned" || alias === "involved" || alias === "recently_closed"
            ? GRAPHQL_BROAD_BUCKET_LIMIT
            : GRAPHQL_REVIEW_BUCKET_LIMIT;
        if (numberValue(connection.issueCount) > limit) cappedBuckets.push(alias);
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

      const details = yield* fetchGraphqlDetails([...aliasesByNodeId.keys()]);
      if (aliasesByNodeId.size > 0 && details.nodesById.size === 0) {
        return yield* fetchFallback(
          viewer,
          `${details.errorMessage ?? "GitHub GraphQL PR detail request failed."} Showing fallback search results.`,
        );
      }

      const teamSet = new Set(viewer.teams);
      const pullRequests = [...aliasesByNodeId.entries()]
        .map(([nodeId, aliases]) => {
          const node = details.nodesById.get(nodeId);
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

      if (teamListCapped) cappedBuckets.push("team_review_teams");
      const missingDetailCount = aliasesByNodeId.size - details.nodesById.size;
      const missingDetailMessage =
        missingDetailCount > 0
          ? `GitHub GraphQL returned incomplete PR detail data for ${missingDetailCount} PR(s).`
          : undefined;
      const detailErrorMessage = details.degraded
        ? (details.errorMessage ?? "GitHub GraphQL returned partial PR detail data.")
        : missingDetailMessage;
      const detailDegraded = details.degraded || missingDetailCount > 0;

      return {
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

  const upsertRefreshState = (input: {
    readonly viewerLogin: string;
    readonly status: PrHubSnapshot["status"];
    readonly lastPolledAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly errorKind?: string | undefined;
    readonly errorMessage?: string | undefined;
    readonly cappedBuckets?: ReadonlyArray<string> | undefined;
  }) =>
    sql`
      INSERT INTO pr_hub_refresh_state (
        provider_kind,
        host,
        viewer_login,
        status,
        last_polled_at,
        last_success_at,
        error_kind,
        error_message,
        capped_buckets_json
      )
      VALUES (
        ${providerKind},
        ${host},
        ${input.viewerLogin},
        ${input.status},
        ${input.lastPolledAt},
        ${input.lastSuccessAt},
        ${input.errorKind ?? null},
        ${input.errorMessage ?? null},
        ${JSON.stringify(input.cappedBuckets ?? [])}
      )
      ON CONFLICT (provider_kind, host, viewer_login)
      DO UPDATE SET
        provider_kind = excluded.provider_kind,
        status = excluded.status,
        last_polled_at = excluded.last_polled_at,
        last_success_at = COALESCE(excluded.last_success_at, pr_hub_refresh_state.last_success_at),
        error_kind = excluded.error_kind,
        error_message = excluded.error_message,
        capped_buckets_json = excluded.capped_buckets_json
    `;

  const persistPullRequests = (
    viewer: ViewerIdentity,
    pullRequests: ReadonlyArray<TrackedPullRequest>,
    options: {
      readonly reconcilePolicy: ReconcilePolicy;
      readonly excludedRepos: ReadonlySet<string>;
    },
  ) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const seenKeys = new Set(
        pullRequests.map((pr) => `${pr.repository.nameWithOwner}#${pr.number}`),
      );
      for (const pr of pullRequests) {
        yield* sql`
          INSERT INTO pr_hub_prs (
            provider_kind,
            host,
            repo,
            number,
            node_id,
            title,
            url,
            author,
            state,
            draft,
            check_rollup,
            review_decision,
            mergeable,
            merge_state_status,
            additions,
            deletions,
            changed_files,
            created_at,
            updated_at,
            closed_at,
            payload_json
          )
          VALUES (
            ${pr.provider},
            ${pr.host},
            ${pr.repository.nameWithOwner},
            ${pr.number},
            ${pr.nodeId},
            ${pr.title},
            ${pr.url},
            ${pr.author},
            ${pr.state},
            ${pr.isDraft ? 1 : 0},
            ${pr.checkRollup},
            ${pr.reviewDecision},
            ${pr.mergeable},
            ${pr.mergeStateStatus},
            ${pr.additions},
            ${pr.deletions},
            ${pr.changedFiles},
            ${pr.createdAt},
            ${pr.updatedAt},
            ${pr.state === "open" ? null : pr.updatedAt},
            ${JSON.stringify(pr)}
          )
          ON CONFLICT (provider_kind, host, repo, number)
          DO UPDATE SET
            provider_kind = excluded.provider_kind,
            title = excluded.title,
            node_id = excluded.node_id,
            url = excluded.url,
            author = excluded.author,
            state = excluded.state,
            draft = excluded.draft,
            check_rollup = excluded.check_rollup,
            review_decision = excluded.review_decision,
            mergeable = excluded.mergeable,
            merge_state_status = excluded.merge_state_status,
            additions = excluded.additions,
            deletions = excluded.deletions,
            changed_files = excluded.changed_files,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            closed_at = excluded.closed_at,
            payload_json = excluded.payload_json
        `;
        yield* sql`
          INSERT INTO pr_hub_viewer_state (
            provider_kind,
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
            ignored_at,
            last_matched_at,
            no_longer_relevant_at,
            stale_inaccessible_count,
            stale_inaccessible_at
          )
          VALUES (
            ${pr.provider},
            ${pr.host},
            ${viewer.login},
            ${pr.repository.nameWithOwner},
            ${pr.number},
            ${JSON.stringify(pr.roles)},
            ${pr.attentionState},
            ${pr.attentionBucket},
            ${pr.primaryReason},
            ${pr.nextAction},
            ${pr.updatedAt},
            ${pr.attentionFingerprint},
            ${null},
            ${null},
            ${null},
            ${pr.snoozedUntil},
            ${pr.ignoredAt},
            ${now},
            ${null},
            ${0},
            ${null}
          )
          ON CONFLICT (provider_kind, host, viewer_login, repo, number)
          DO UPDATE SET
            provider_kind = excluded.provider_kind,
            roles_json = excluded.roles_json,
            attention_state = excluded.attention_state,
            attention_bucket = excluded.attention_bucket,
            primary_reason = excluded.primary_reason,
            next_action = excluded.next_action,
            sort_timestamp = excluded.sort_timestamp,
            attention_fingerprint = excluded.attention_fingerprint,
            snoozed_until = COALESCE(pr_hub_viewer_state.snoozed_until, excluded.snoozed_until),
            ignored_at = pr_hub_viewer_state.ignored_at,
            last_matched_at = excluded.last_matched_at,
            no_longer_relevant_at = NULL,
            stale_inaccessible_count = 0,
            stale_inaccessible_at = NULL
        `;
      }

      for (const repo of options.excludedRepos) {
        yield* sql`
          UPDATE pr_hub_viewer_state
          SET no_longer_relevant_at = ${now}
          WHERE provider_kind = ${providerKind}
            AND host = ${host}
            AND viewer_login = ${viewer.login}
            AND lower(repo) = ${repo}
        `;
        yield* sql`
          DELETE FROM pr_hub_prs
          WHERE provider_kind = ${providerKind}
            AND host = ${host}
            AND lower(repo) = ${repo}
        `;
      }

      const applyTerminalState = (row: PersistedPrRow, terminal: ReconciledPrState) =>
        Effect.gen(function* () {
          const attention = terminalAttention(terminal.state);
          const fingerprint = terminalFingerprint({
            host,
            repo: row.repo,
            number: row.number,
            state: terminal.state,
            updatedAt: terminal.updatedAt,
          });
          const payload = parsePayload(row.payload_json);
          const nextPayload = JSON.stringify({
            ...payload,
            nodeId: terminal.nodeId ?? row.node_id,
            state: terminal.state,
            updatedAt: terminal.updatedAt,
          });
          yield* sql`
            UPDATE pr_hub_prs
            SET
              node_id = ${terminal.nodeId ?? row.node_id},
              state = ${terminal.state},
              updated_at = ${terminal.updatedAt},
              closed_at = ${terminal.closedAt},
              payload_json = ${nextPayload}
            WHERE provider_kind = ${providerKind}
              AND host = ${host}
              AND repo = ${row.repo}
              AND number = ${row.number}
          `;
          yield* sql`
            UPDATE pr_hub_viewer_state
            SET
              attention_state = ${attention.attentionState},
              attention_bucket = ${attention.attentionBucket},
              primary_reason = ${attention.primaryReason},
              next_action = ${attention.nextAction},
              sort_timestamp = ${terminal.updatedAt},
              attention_fingerprint = ${fingerprint},
              last_matched_at = ${now},
              no_longer_relevant_at = NULL,
              stale_inaccessible_count = 0,
              stale_inaccessible_at = NULL
            WHERE provider_kind = ${providerKind}
              AND host = ${host}
              AND viewer_login = ${viewer.login}
              AND repo = ${row.repo}
              AND number = ${row.number}
          `;
        });

      const existing = yield* sql<PersistedPrRow>`
        SELECT
          v.repo,
          v.number,
          p.node_id,
          v.stale_inaccessible_count,
          p.payload_json
        FROM pr_hub_viewer_state v
        INNER JOIN pr_hub_prs p
          ON p.provider_kind = v.provider_kind
          AND p.host = v.host
          AND p.repo = v.repo
          AND p.number = v.number
        WHERE v.provider_kind = ${providerKind}
          AND v.host = ${host}
          AND v.viewer_login = ${viewer.login}
          AND v.no_longer_relevant_at IS NULL
      `;
      const missingRows = existing.filter((row) => !seenKeys.has(`${row.repo}#${row.number}`));
      const terminalByNodeId = yield* fetchReconciledPullRequestStates(
        missingRows.map((row) => row.node_id).filter((nodeId): nodeId is string => nodeId !== null),
      );
      const terminalByKey = yield* fetchReconciledPullRequestStatesByNumber(
        missingRows.filter((row) => row.node_id === null),
      );
      for (const row of missingRows) {
        const terminal = row.node_id
          ? terminalByNodeId.get(row.node_id)
          : terminalByKey.get(`${row.repo}#${row.number}`);
        if (terminal) {
          yield* applyTerminalState(row, terminal);
          continue;
        }
        if (options.reconcilePolicy === "terminal_only") continue;
        const nextMissCount = row.stale_inaccessible_count + 1;
        yield* sql`
          UPDATE pr_hub_viewer_state
          SET
            stale_inaccessible_count = ${nextMissCount},
            stale_inaccessible_at = ${now},
            no_longer_relevant_at = CASE
              WHEN ${nextMissCount} >= 3 THEN ${now}
              ELSE no_longer_relevant_at
            END
          WHERE provider_kind = ${providerKind}
            AND host = ${host}
            AND viewer_login = ${viewer.login}
            AND repo = ${row.repo}
            AND number = ${row.number}
        `;
      }
      const resolvedBefore = new Date(Date.now() - RESOLVED_RETENTION_MS).toISOString();
      const irrelevantBefore = new Date(Date.now() - NO_LONGER_RELEVANT_RETENTION_MS).toISOString();
      yield* sql`
        DELETE FROM pr_hub_viewer_state
        WHERE provider_kind = ${providerKind}
          AND host = ${host}
          AND viewer_login = ${viewer.login}
          AND no_longer_relevant_at IS NOT NULL
          AND no_longer_relevant_at < ${irrelevantBefore}
      `;
      yield* sql`
        DELETE FROM pr_hub_prs
        WHERE provider_kind = ${providerKind}
          AND host = ${host}
          AND state IN ('closed', 'merged')
          AND closed_at IS NOT NULL
          AND closed_at < ${resolvedBefore}
      `;
    });

  const fetchAndPersist = (mode: PrHubRefreshInput["mode"]) =>
    Effect.gen(function* () {
      const currentSettings = yield* settings.getSettings;
      const intervalSeconds =
        currentSettings.prHub.pollIntervalSeconds === 0
          ? 0
          : Math.max(60, currentSettings.prHub.pollIntervalSeconds);
      if (mode === "if_stale") {
        if (intervalSeconds === 0) return yield* getSnapshot;
        const current = yield* getSnapshot;
        if (current.lastPolledAt) {
          const elapsedMs = Date.now() - new Date(current.lastPolledAt).getTime();
          if (Number.isFinite(elapsedMs) && elapsedMs < intervalSeconds * 1000) {
            return current;
          }
        }
      }

      const viewerExit = yield* Effect.exit(resolveViewer);
      if (Exit.isFailure(viewerExit)) {
        const existing = yield* getSnapshot;
        const squashedError = Cause.squash(viewerExit.cause);
        const errorRecord = asRecord(squashedError);
        const kind = stringValue(errorRecord?.kind) ?? "generic";
        const message = causeUserMessage(viewerExit.cause, "Failed to resolve GitHub account.");
        const status =
          kind === "provider_missing"
            ? "gh_missing"
            : kind === "unauthenticated"
              ? "auth_required"
              : "error";
        const snapshot = {
          ...existing,
          status,
          host,
          errorKind: kind,
          errorMessage: message,
          authStates: [
            githubAuthState({
              host,
              viewerLogin: existing.viewerLogin,
              status,
              errorKind: kind,
              errorMessage: message,
            }),
          ],
        } satisfies PrHubSnapshot;
        return yield* publishSnapshot(snapshot);
      }

      const viewer = viewerExit.value;
      const previousState = yield* viewerStateMap(viewer.login);
      const fetched = yield* fetchGraphql(viewer);
      const excludeRepos = new Set(
        currentSettings.prHub.excludeRepos.map((repo) => repo.trim().toLowerCase()).filter(Boolean),
      );
      const tracked = fetched.pullRequests
        .filter((pr) => !excludeRepos.has(pr.repository.nameWithOwner.toLowerCase()))
        .map((pr) =>
          buildTrackedPullRequest(
            pr,
            viewer.login,
            previousState.get(`${pr.repository.nameWithOwner}#${pr.number}`),
          ),
        );
      const reconcilePolicy: ReconcilePolicy =
        fetched.degraded || fetched.cappedBuckets.length > 0 ? "terminal_only" : "authoritative";
      yield* persistPullRequests(viewer, tracked, {
        reconcilePolicy,
        excludedRepos: excludeRepos,
      });
      const now = new Date().toISOString();
      yield* upsertRefreshState({
        viewerLogin: viewer.login,
        status: fetched.degraded ? "degraded" : "ok",
        lastPolledAt: now,
        lastSuccessAt: fetched.degraded ? null : now,
        errorKind: fetched.degraded ? "degraded" : undefined,
        errorMessage: fetched.errorMessage,
        cappedBuckets: fetched.cappedBuckets,
      });
      return yield* hydrateSnapshot(viewer.login).pipe(Effect.flatMap(publishSnapshot));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const viewer = yield* Ref.get(viewerRef);
          if (viewer) {
            const message = causeUserMessage(cause, "PR Hub refresh failed.");
            yield* upsertRefreshState({
              viewerLogin: viewer.login,
              status: "error",
              lastPolledAt: new Date().toISOString(),
              lastSuccessAt: null,
              errorKind: "error",
              errorMessage: message,
            }).pipe(Effect.ignore);
          }
          const existing = yield* getSnapshot;
          const message = causeUserMessage(cause, "PR Hub refresh failed.");
          return yield* publishSnapshot({
            ...existing,
            status: "error",
            errorKind: "error",
            errorMessage: message,
            authStates: [
              githubAuthState({
                host,
                viewerLogin: existing.viewerLogin,
                status: "error",
                errorKind: "error",
                errorMessage: message,
              }),
            ],
          });
        }),
      ),
    );

  const refreshNow: PrHubServiceShape["refreshNow"] = (input) =>
    Effect.gen(function* () {
      while (true) {
        const deferred = yield* Deferred.make<PrHubSnapshot>();
        const state = yield* Ref.modify(
          inFlightRef,
          (
            current,
          ): readonly [
            {
              readonly started: boolean;
              readonly deferred: Deferred.Deferred<PrHubSnapshot>;
            },
            Deferred.Deferred<PrHubSnapshot> | null,
          ] => {
            if (current) return [{ started: false, deferred: current }, current] as const;
            return [{ started: true, deferred }, deferred] as const;
          },
        );
        if (!state.started) {
          const joined = yield* Deferred.await(state.deferred);
          if (input.mode === "force") {
            const current = yield* Ref.get(inFlightRef);
            if (current === null) continue;
          }
          return joined;
        }
        const exit = yield* Effect.exit(fetchAndPersist(input.mode));
        yield* Ref.set(inFlightRef, null);
        if (Exit.isSuccess(exit)) {
          yield* Deferred.succeed(deferred, exit.value).pipe(Effect.orDie);
        } else {
          const existing = yield* getSnapshot;
          yield* Deferred.succeed(deferred, existing).pipe(Effect.orDie);
        }
        return yield* Deferred.await(deferred);
      }
    });

  yield* Stream.fromPubSub(actionRefreshPubSub).pipe(
    Stream.runForEach(() =>
      refreshNow({ mode: "force" }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PR Hub post-action refresh failed", {
            detail: causeUserMessage(cause, "PR Hub refresh failed after pull request action."),
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  const refreshAfterAction = <E>(effect: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      yield* effect;
      yield* PubSub.publish(actionRefreshPubSub, undefined).pipe(Effect.asVoid);
      return yield* getSnapshot;
    });

  const prHubActionError = (detail: string) =>
    new SourceControlProviderError({
      provider: "github",
      operation: "prHub.action",
      detail,
      kind: "forbidden",
    });

  const prHubPersistenceError = (operation: string, cause: unknown) =>
    new SourceControlProviderError({
      provider: "github",
      operation,
      detail: "Could not persist PR Hub state.",
      kind: "generic",
      cause,
    });

  const persistPrHubState =
    (operation: string) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("failed to persist PR Hub state", {
            operation,
            cause: String(error),
          }),
        ),
        Effect.mapError((error) => prHubPersistenceError(operation, error)),
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

  const getFiles: PrHubServiceShape["getFiles"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const provider = yield* sourceControlProviders.get(pr.provider);
          const { owner, repo } = yield* repositoryParts(pr);
          return yield* readPrDetailCache({
            cache: filesCache,
            key: `${pr.key}|${input.cursor ?? "first"}`,
            mode: input.mode ?? "if_stale",
            fetch: provider
              .query({
                cwd,
                host: pr.host,
                document: GITHUB_PR_FILES_QUERY,
                variables: {
                  owner,
                  repo,
                  number: pr.number,
                  ...(input.cursor ? { cursor: input.cursor } : {}),
                },
              })
              .pipe(
                Effect.flatMap((response) =>
                  decodeDetailResponse(pr, "prHub.getFiles.decode", () => {
                    const decoded = decodeGitHubPrFiles(response);
                    return {
                      files: [...decoded.files],
                      pageInfo: decoded.pageInfo,
                      stale: false,
                      refreshedAt: new Date().toISOString(),
                    } satisfies PrHubFilesPage;
                  }),
                ),
              ),
          });
        }),
      ),
    );

  const reconcileDetailMutation = (pr: TrackedPullRequest) =>
    Effect.all(
      [getDetail({ key: pr.key, mode: "force" }), getTimeline({ key: pr.key, mode: "force" })],
      { concurrency: 2 },
    ).pipe(Effect.map(([detail, timeline]) => ({ detail, timeline })));

  const cachedAuthoritativeTimelineComment = (
    pr: TrackedPullRequest,
    predicate: (comment: PrHubTimelineComment) => boolean,
  ): PrHubTimelineComment | null => {
    const prefix = `${pr.key}|`;
    for (const [key, cached] of timelineCache) {
      if (!key.startsWith(prefix)) continue;
      const match = cached.value.entries.find(
        (entry): entry is PrHubTimelineComment => entry.type === "comment" && predicate(entry),
      );
      if (match) return match;
    }
    return null;
  };

  const findAuthoritativeTimelineComment = (
    pr: TrackedPullRequest,
    predicate: (comment: PrHubTimelineComment) => boolean,
  ): Effect.Effect<PrHubTimelineComment | null, SourceControlProviderError> =>
    Effect.gen(function* () {
      const cachedMatch = cachedAuthoritativeTimelineComment(pr, predicate);
      if (cachedMatch) return cachedMatch;
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = yield* getTimeline({ key: pr.key, cursor, mode: "if_stale" });
        if (page.stale) {
          return yield* prHubActionError(
            "GitHub could not verify the selected pull request object. Refresh and try again.",
          );
        }
        const match = page.entries.find(
          (entry): entry is PrHubTimelineComment => entry.type === "comment" && predicate(entry),
        );
        if (match) return match;
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return null;
        cursor = page.pageInfo.endCursor;
      }
      return yield* prHubActionError(
        "The selected pull request object is outside the authorized timeline window.",
      );
    });

  const authorizeCommentUpdate = (
    pr: TrackedPullRequest,
    input: { readonly commentId: string; readonly kind: "issue-comment" | "review-comment" },
  ) =>
    findAuthoritativeTimelineComment(
      pr,
      (comment) =>
        comment.databaseId === input.commentId &&
        comment.kind === input.kind &&
        comment.viewerCanUpdate,
    ).pipe(
      Effect.flatMap((comment) =>
        comment
          ? Effect.void
          : Effect.fail(
              prHubActionError(
                "The selected comment does not belong to this pull request or cannot be edited.",
              ),
            ),
      ),
    );

  const authorizeReactionSubject = (pr: TrackedPullRequest, subjectId: string) =>
    getDetail({ key: pr.key, mode: "force" }).pipe(
      Effect.flatMap((result) => {
        if (result.stale) {
          return Effect.fail(
            prHubActionError(
              "GitHub could not verify the selected pull request object. Refresh and try again.",
            ),
          );
        }
        const providerDetails = result.detail.providerDetails;
        if (providerDetails.provider === "github" && providerDetails.nodeId === subjectId) {
          return Effect.void;
        }
        return findAuthoritativeTimelineComment(pr, (comment) => comment.id === subjectId).pipe(
          Effect.flatMap((comment) =>
            comment
              ? Effect.void
              : Effect.fail(
                  prHubActionError(
                    "The selected reaction target does not belong to this pull request.",
                  ),
                ),
          ),
        );
      }),
    );

  const validateReactionMutation = (
    pr: TrackedPullRequest,
    response: unknown,
    reacted: boolean,
  ): Effect.Effect<void, SourceControlProviderError> =>
    decodeDetailResponse(pr, "prHub.setReaction.decode", () => {
      const root = asRecord(response);
      if (!root || (Array.isArray(root.errors) && root.errors.length > 0)) {
        throw new Error("GitHub rejected the reaction mutation.");
      }
      const data = asRecord(root.data);
      const payload = asRecord(data?.[reacted ? "addReaction" : "removeReaction"]);
      const subject = asRecord(payload?.subject);
      if (!payload || stringValue(subject?.id) === null) {
        throw new Error("GitHub returned an incomplete reaction mutation response.");
      }
    });

  const requireTrackedPr = (
    url: string,
    predicate: (pr: TrackedPullRequest) => boolean,
    detail: string,
  ): Effect.Effect<TrackedPullRequest, SourceControlProviderError> =>
    trackedPrByUrl(url).pipe(
      Effect.flatMap((pr) =>
        predicate(pr) ? Effect.succeed(pr) : Effect.fail(prHubActionError(detail)),
      ),
    );

  const validReviewerPattern = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;
  const normalizeReviewerInputs = (reviewers: ReadonlyArray<string>) =>
    reviewers.map((reviewer) => reviewer.trim()).filter(Boolean);

  const validateReviewers = (
    reviewers: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, SourceControlProviderError> => {
    const normalized = normalizeReviewerInputs(reviewers);
    if (normalized.length === 0) {
      return Effect.fail(prHubActionError("No reviewers are available to re-request."));
    }
    const invalid = normalized.find((reviewer) => !validReviewerPattern.test(reviewer));
    if (invalid) {
      return Effect.fail(prHubActionError(`Invalid reviewer name: ${invalid}`));
    }
    return Effect.succeed(normalized);
  };

  const mutateLocalState = (
    key: PullRequestKey,
    update: (current: TrackedPullRequest) => Partial<TrackedPullRequest>,
  ) =>
    Ref.get(snapshotRef).pipe(
      Effect.flatMap((snapshot) => {
        if (!snapshot) return getSnapshot;
        const mapPr = (pr: TrackedPullRequest): TrackedPullRequest =>
          sourceControlPullRequestKeysEqual(pr.key, key) ? { ...pr, ...update(pr) } : pr;
        return publishSnapshot({
          ...snapshot,
          pullRequests: snapshot.pullRequests.map(mapPr),
          recentlyResolved: snapshot.recentlyResolved.map(mapPr),
        });
      }),
    );

  const markSeen: PrHubServiceShape["markSeen"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET last_seen_fingerprint = ${input.attentionFingerprint}
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_login = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.markSeen"));
      return yield* mutateLocalState(input.key, () => ({ notificationPending: false }));
    });

  const markNotified: PrHubServiceShape["markNotified"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET
          last_notified_fingerprint = ${input.attentionFingerprint},
          last_notified_at = ${new Date().toISOString()}
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_login = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.markNotified"));
      return yield* mutateLocalState(input.key, () => ({ notificationPending: false }));
    });

  const snooze: PrHubServiceShape["snooze"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET snoozed_until = ${input.until}
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_login = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.snooze"));
      return yield* mutateLocalState(input.key, () => ({
        snoozedUntil: input.until,
        notificationPending: false,
      }));
    });

  const unsnooze: PrHubServiceShape["unsnooze"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!parsed || !viewerLogin) return snapshot;
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET snoozed_until = NULL
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_login = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.unsnooze"));
      return yield* hydrateSnapshot(viewerLogin).pipe(Effect.flatMap(publishSnapshot));
    });

  const ignore: PrHubServiceShape["ignore"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseSourceControlPullRequestKey(input.key);
      const snapshot = yield* getSnapshot;
      const viewerLogin = snapshot.viewerLogin;
      if (!parsed || !viewerLogin) return snapshot;
      const ignoredAt = new Date().toISOString();
      yield* sql`
        UPDATE pr_hub_viewer_state
        SET
          ignored_at = ${ignoredAt},
          last_seen_fingerprint = attention_fingerprint
        WHERE provider_kind = ${parsed.provider}
          AND host = ${parsed.host}
          AND viewer_login = ${viewerLogin}
          AND repo = ${parsed.repository}
          AND number = ${parsed.number}
      `.pipe(persistPrHubState("prHub.ignore"));
      return yield* hydrateSnapshot(viewerLogin).pipe(Effect.flatMap(publishSnapshot));
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
      const allProjects = yield* projects.listAll().pipe(Effect.catch(() => Effect.succeed([])));
      const candidates: PrHubLocalCheckoutCandidate[] = [];
      for (const project of allProjects) {
        if (project.deletedAt !== null) continue;
        const remotes = yield* git.listRemotes(project.workspaceRoot).pipe(
          Effect.catch(() =>
            git.readConfigValue(project.workspaceRoot, "remote.origin.url").pipe(
              Effect.map((url) => (url ? [{ name: "origin", url }] : [])),
              Effect.catch(() => Effect.succeed([])),
            ),
          ),
        );
        const matches = discoverSourceControlProviderIdentities(remotes, {
          githubHosts: [host],
        }).some((identity) => {
          if (identity.kind !== pr.provider) return false;
          if (identity.host?.toLowerCase() !== pr.host.toLowerCase()) return false;
          const repository = `${identity.owner}/${identity.repository}`.toLowerCase();
          return repository === pr.repository.nameWithOwner.toLowerCase();
        });
        if (!matches) continue;
        candidates.push({
          projectId: project.projectId,
          projectTitle: project.title,
          cwd: project.workspaceRoot,
          repository: pr.repository,
        });
      }
      return candidates;
    });

  const updateComment: PrHubServiceShape["updateComment"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        /^\d+$/.test(input.commentId)
          ? authorizeCommentUpdate(pr, input).pipe(
              Effect.andThen(sourceControlProviders.get(pr.provider)),
              Effect.flatMap((provider) =>
                provider.updatePullRequestComment({
                  cwd,
                  host: pr.host,
                  repository: pr.repository.nameWithOwner,
                  commentId: input.commentId,
                  kind: input.kind,
                  body: input.body,
                }),
              ),
              Effect.andThen(reconcileDetailMutation(pr)),
            )
          : Effect.fail(prHubActionError("The selected comment cannot be edited.")),
      ),
    );

  const setReaction: PrHubServiceShape["setReaction"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        authorizeReactionSubject(pr, input.subjectId).pipe(
          Effect.andThen(sourceControlProviders.get(pr.provider)),
          Effect.flatMap((provider) =>
            provider.requireCapability("react").pipe(
              Effect.andThen(
                provider
                  .query({
                    cwd,
                    host: pr.host,
                    document: input.reacted
                      ? GITHUB_ADD_REACTION_MUTATION
                      : GITHUB_REMOVE_REACTION_MUTATION,
                    variables: {
                      subjectId: input.subjectId,
                      content: GITHUB_REACTION_CONTENT[input.content],
                    },
                  })
                  .pipe(
                    Effect.flatMap((response) =>
                      validateReactionMutation(pr, response, input.reacted),
                    ),
                  ),
              ),
            ),
          ),
          Effect.andThen(reconcileDetailMutation(pr)),
        ),
      ),
    );

  const changeReviewers: PrHubServiceShape["changeReviewers"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        Effect.gen(function* () {
          const add = [...new Set(normalizeReviewerInputs(input.add))];
          const remove = [...new Set(normalizeReviewerInputs(input.remove))];
          if (add.length === 0 && remove.length === 0) {
            return yield* prHubActionError("Choose at least one reviewer change.");
          }
          const invalid = [...add, ...remove].find(
            (reviewer) => !validReviewerPattern.test(reviewer),
          );
          if (invalid) {
            return yield* prHubActionError(`Invalid reviewer name: ${invalid}`);
          }
          const removing = new Set(remove.map((reviewer) => reviewer.toLowerCase()));
          const overlap = add.find((reviewer) => removing.has(reviewer.toLowerCase()));
          if (overlap) {
            return yield* prHubActionError(
              `Reviewer '${overlap}' cannot be added and removed together.`,
            );
          }
          const provider = yield* sourceControlProviders.get(pr.provider);
          yield* provider.changePullRequestReviewers({ cwd, url: pr.url, add, remove });
          yield* PubSub.publish(actionRefreshPubSub, undefined);
          return yield* reconcileDetailMutation(pr);
        }),
      ),
    );

  const updateBranch: PrHubServiceShape["updateBranch"] = (input) =>
    trackedPrByKey(input.key).pipe(
      Effect.flatMap((pr) =>
        pr.state === "open"
          ? sourceControlProviders.get(pr.provider).pipe(
              Effect.flatMap((provider) =>
                provider.updatePullRequestBranch({ cwd, url: pr.url, method: input.method }),
              ),
              Effect.tap(() => PubSub.publish(actionRefreshPubSub, undefined)),
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const cacheKey of filesCache.keys()) {
                    if (cacheKey.startsWith(`${pr.key}|`)) filesCache.delete(cacheKey);
                  }
                }),
              ),
              Effect.andThen(reconcileDetailMutation(pr)),
            )
          : Effect.fail(prHubActionError("Only open pull-request branches can be updated.")),
      ),
    );

  const clearData: PrHubServiceShape["clearData"] = () =>
    Effect.gen(function* () {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM pr_hub_advisories`;
            yield* sql`DELETE FROM pr_hub_viewer_state`;
            yield* sql`DELETE FROM pr_hub_prs`;
            yield* sql`DELETE FROM pr_hub_refresh_state`;
          }),
        )
        .pipe(persistPrHubState("prHub.clearData"));
      detailCache.clear();
      timelineCache.clear();
      filesCache.clear();
      return yield* publishSnapshot(emptySnapshot({ host }));
    });

  return {
    getSnapshot,
    refreshNow,
    streamSnapshots: Stream.fromPubSub(snapshotPubSub),
    approve: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.state === "open" && !pr.roles.includes("author") && pr.viewerReviewRequested,
        "Approve is only available for tracked PRs requesting your review.",
      ).pipe(
        Effect.flatMap((pr) => sourceControlProviders.get(pr.provider)),
        Effect.flatMap((provider) =>
          refreshAfterAction(provider.approvePullRequest({ cwd, ...input })),
        ),
      ),
    requestChanges: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.state === "open" && !pr.roles.includes("author") && pr.viewerReviewRequested,
        "Request changes is only available for tracked PRs requesting your review.",
      ).pipe(
        Effect.flatMap((pr) => sourceControlProviders.get(pr.provider)),
        Effect.flatMap((provider) =>
          refreshAfterAction(provider.requestChanges({ cwd, ...input })),
        ),
      ),
    comment: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.state === "open",
        "Comment is only available for tracked open PRs.",
      ).pipe(
        Effect.flatMap((pr) => sourceControlProviders.get(pr.provider)),
        Effect.flatMap((provider) =>
          refreshAfterAction(provider.commentPullRequest({ cwd, ...input })),
        ),
      ),
    merge: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.roles.includes("author") && pr.attentionState === "ready_to_merge",
        "Merge is only available for tracked author PRs that are ready to merge.",
      ).pipe(
        Effect.flatMap((pr) => {
          const headRefOid = pr.headRefOid;
          if (!headRefOid) {
            return Effect.fail(
              prHubActionError("Cannot merge because the tracked PR head commit is unknown."),
            );
          }
          return sourceControlProviders.get(pr.provider).pipe(
            Effect.flatMap((provider) =>
              refreshAfterAction(
                provider.mergePullRequest({
                  cwd,
                  url: input.url,
                  method: input.method,
                  expectedHeadOid: headRefOid,
                }),
              ),
            ),
          );
        }),
      ),
    markReady: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.roles.includes("author") && pr.attentionState === "draft",
        "Mark ready is only available for tracked draft PRs you authored.",
      ).pipe(
        Effect.flatMap((pr) => sourceControlProviders.get(pr.provider)),
        Effect.flatMap((provider) =>
          refreshAfterAction(provider.markPullRequestReady({ cwd, ...input })),
        ),
      ),
    reRequestReview: (input) =>
      requireTrackedPr(
        input.url,
        (pr) => pr.roles.includes("author") && pr.attentionState === "awaiting_review",
        "Re-request review is only available for tracked author PRs awaiting review.",
      ).pipe(
        Effect.flatMap((pr) =>
          validateReviewers(
            input.reviewers?.length ? input.reviewers : pr.reviewRequestReviewers,
          ).pipe(
            Effect.flatMap((reviewers) =>
              sourceControlProviders.get(pr.provider).pipe(
                Effect.flatMap((provider) =>
                  refreshAfterAction(
                    provider.addPullRequestReviewers({
                      cwd,
                      url: input.url,
                      reviewers,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    snooze,
    unsnooze,
    ignore,
    markSeen,
    markNotified,
    listLocalCheckoutCandidates,
    getDetail,
    getTimeline,
    getFiles,
    updateComment,
    setReaction,
    changeReviewers,
    updateBranch,
    clearData,
  } satisfies PrHubServiceShape;
});

export const PrHubServiceLive = Layer.effect(PrHubService, makePrHubService);
