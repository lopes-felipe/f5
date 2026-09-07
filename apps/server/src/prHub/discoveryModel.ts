import {
  PR_HUB_BRANCH_REQUIREMENTS_FIELDS,
  unknownMergeRequirements,
} from "./mergeRequirements.ts";

import { ATTENTION_CONNECTION_FIELDS } from "./attentionPagination.ts";

import { type GitHubCredentialContext } from "../git/githubApi.ts";

import { createHash } from "node:crypto";
import os from "node:os";

import {
  PullRequestKey,
  type PrAttentionBucket,
  type PrAttentionState,
  type PrCheckRollup,
  type PrHubSnapshot,
  type PrMergeable,
  type PrPullRequestState,
  type PrRepositoryRef,
  type PrReviewDecision,
  type PrViewerRole,
  type SourceControlHostAuthState,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import {
  derivePrAttention,
  derivePrAttentionReasons,
  derivePrWaitingSince,
  prAttentionText,
} from "@t3tools/shared/prHub";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { Cause } from "effect";

import { GITHUB_SOURCE_CONTROL_CAPABILITIES } from "../sourceControl/GitHubSourceControlProvider.ts";

export const DEFAULT_HOST = process.env.GH_HOST?.trim() || "github.com";
const SEARCH_SORT_QUALIFIER = "sort:updated-desc";
const SEARCH_OPEN_PREFIX = `is:pr is:open archived:false ${SEARCH_SORT_QUALIFIER}`;
export const TEAM_QUERY_CHUNK_SIZE = 10;
export const TEAM_QUERY_CHUNK_COUNT = 5;
export const PR_HUB_DETAILS_CHUNK_SIZE = 8;
export const RECONCILE_NODE_CHUNK_SIZE = 50;
export const RECONCILE_REPO_NUMBER_CHUNK_SIZE = 20;
export const RESOLVED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const NO_LONGER_RELEVANT_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface ViewerIdentity {
  readonly context: GitHubCredentialContext;
  readonly login: string;
  readonly teams: ReadonlyArray<string>;
  readonly teamLookupError: string | null;
  readonly teamsCheckedAt: number;
}

export interface ViewerStateRow {
  readonly viewer_payload_json: string;
  readonly roles_json: string;
  readonly attention_fingerprint: string;
  readonly last_acknowledged_fingerprint?: string | null;
  readonly acknowledged_at?: string | null;
  readonly last_seen_fingerprint: string | null;
  readonly last_notified_fingerprint: string | null;
  readonly snoozed_until: string | null;
  readonly ignored_at: string | null;
  readonly no_longer_relevant_at: string | null;
}

export interface PrDbRow {
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
  readonly viewer_payload_json: string;
  readonly roles_json: string;
  readonly attention_state: PrAttentionState;
  readonly attention_bucket: PrAttentionBucket;
  readonly primary_reason: string;
  readonly next_action: string;
  readonly attention_fingerprint: string;
  readonly last_acknowledged_fingerprint?: string | null;
  readonly acknowledged_at?: string | null;
  readonly last_seen_fingerprint: string | null;
  readonly last_notified_fingerprint: string | null;
  readonly snoozed_until: string | null;
  readonly ignored_at: string | null;
  readonly no_longer_relevant_at: string | null;
}

export interface RefreshStateRow {
  readonly viewer_id: string;
  readonly status: PrHubSnapshot["status"];
  readonly last_polled_at: string | null;
  readonly error_kind: string | null;
  readonly error_message: string | null;
  readonly coverage_json: string | null;
}

export interface NormalizedPr {
  readonly mergeRequirements?: TrackedPullRequest["mergeRequirements"];
  readonly reasonEvidence?: Record<string, { id: string; url: string }[]>;
  readonly repositoryArchived: boolean;
  readonly mergePermission: "allowed" | "denied" | "unknown";
  readonly lastVerifiedAt: string | null;
  readonly actionableUnresolvedThreadCount: number;
  readonly reviewFactsComplete?: boolean;
  readonly reasonEvidenceTruncated?: boolean;
  readonly headCommittedAt: string | null;
  readonly viewerLastReviewedCommitOid: string | null;
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

export interface FetchResult {
  readonly coverage?: PrHubSnapshot["coverage"];
  readonly pullRequests: ReadonlyArray<NormalizedPr>;
  readonly cappedBuckets: ReadonlyArray<string>;
  readonly degraded: boolean;
  readonly errorMessage?: string | undefined;
}

export interface ReconciledPrState {
  readonly nodeId: string | null;
  readonly state: "closed" | "merged";
  readonly closedAt: string;
  readonly updatedAt: string;
}

export type ReconcilePolicy = "authoritative" | "terminal_only";

export interface PersistedPrRow {
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

export function accountCwd(fallback: string): string {
  const home = os.homedir();
  return home && home.trim().length > 0 ? home : fallback;
}

export function emptySnapshot(input?: {
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

export function githubAuthState(input: {
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

export function asRecord(value: unknown): Record<string, unknown> | null {
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

export function causeUserMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  return errorDetail(Cause.squash(cause)) ?? fallback;
}

export function causeErrorKind(cause: Cause.Cause<unknown>): string | null {
  return stringValue(asRecord(Cause.squash(cause))?.kind);
}

export function shouldSplitDetailChunk(cause: Cause.Cause<unknown>): boolean {
  const kind = causeErrorKind(cause);
  return kind === null || kind === "generic" || kind === "network" || kind === "timeout";
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

export function parseJsonArray(value: string | null | undefined): string[] {
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

export function parsePayload(value: string): Partial<TrackedPullRequest> {
  try {
    const parsed = JSON.parse(value);
    return (asRecord(parsed) as Partial<TrackedPullRequest> | null) ?? {};
  } catch {
    return {};
  }
}

export function repositoryFromNameWithOwner(nameWithOwner: string): PrRepositoryRef {
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

export function keyFor(host: string, repo: string, number: number): PullRequestKey {
  return formatSourceControlPullRequestKey({
    provider: "github",
    host,
    repository: repo,
    number,
  });
}

export function githubProviderFields(input: {
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

export function normalizeTerminalPullRequestState(
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

export function terminalAttention(state: ReconciledPrState["state"]): {
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

export function terminalFingerprint(input: {
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

export function nodeArray(connection: unknown): Record<string, unknown>[] {
  return asArray(asRecord(connection)?.nodes)
    .map(asRecord)
    .filter((node): node is Record<string, unknown> => node !== null);
}

export function labels(node: Record<string, unknown>): string[] {
  return nodeArray(node.labels)
    .map((label) => stringValue(label.name))
    .filter((label): label is string => label !== null);
}

export function assignees(node: Record<string, unknown>): string[] {
  return nodeArray(node.assignees)
    .map((assignee) => stringValue(assignee.login))
    .filter((assignee): assignee is string => assignee !== null);
}

export function unresolvedThreadCount(node: Record<string, unknown>): number {
  const aggregate = asRecord(node.reviewThreads)?.unresolvedCount;
  if (typeof aggregate === "number") return numberValue(aggregate);
  return nodeArray(node.reviewThreads).filter((thread) => thread.isResolved !== true).length;
}

export function reviewRequestReviewers(node: Record<string, unknown>): string[] {
  return nodeArray(node.reviewRequests)
    .map((request) => asRecord(request.requestedReviewer))
    .filter((reviewer): reviewer is Record<string, unknown> => reviewer !== null)
    .map((reviewer) => stringValue(reviewer.login) ?? stringValue(reviewer.combinedSlug))
    .filter((reviewer): reviewer is string => reviewer !== null);
}

export function viewerLatestReview(node: Record<string, unknown>, viewerLogin: string) {
  return nodeArray(node.latestReviews).findLast((review) => {
    const author = asRecord(review.author);
    const login = stringValue(author?.login);
    const state = stringValue(review.state)?.toUpperCase();
    return (
      login?.toLowerCase() === viewerLogin.toLowerCase() &&
      state !== undefined &&
      state !== "PENDING" &&
      state !== "DISMISSED"
    );
  });
}

export function viewerHasReviewed(node: Record<string, unknown>, viewerLogin: string): boolean {
  return viewerLatestReview(node, viewerLogin) !== undefined;
}

function actionableUnresolvedThreads(node: Record<string, unknown>, viewerLogin: string) {
  return nodeArray(node.reviewThreads).filter((thread) => {
    const lastComment = nodeArray(thread.comments).at(-1);
    const login = stringValue(asRecord(lastComment?.author)?.login);
    return (
      thread.isResolved !== true &&
      thread.isOutdated !== true &&
      login !== null &&
      login.toLowerCase() !== viewerLogin.toLowerCase()
    );
  });
}

function reviewReasonEvidence(node: Record<string, unknown>, viewerLogin: string) {
  const evidence = (items: readonly Record<string, unknown>[], urlField = "url") =>
    items.flatMap((item) => {
      const id = stringValue(item.id);
      const url = stringValue(item[urlField]);
      return id && url ? [{ id, url }] : [];
    });
  const review = viewerLatestReview(node, viewerLogin);
  const rollup = asRecord(asRecord(nodeArray(node.commits).at(-1)?.commit)?.statusCheckRollup);
  const checks = nodeArray(rollup?.contexts);
  const failing = checks.filter((check) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      String(check.conclusion ?? check.state),
    ),
  );
  return {
    unresolved_comments: evidence(
      actionableUnresolvedThreads(node, viewerLogin).flatMap((thread) =>
        nodeArray(thread.comments),
      ),
    ),
    changes_pushed: evidence(review ? [review] : []),
    changes_requested: evidence(
      nodeArray(node.latestReviews).filter((item) => item.state === "CHANGES_REQUESTED"),
    ),
    ci_failing: [...evidence(failing, "detailsUrl"), ...evidence(failing, "targetUrl")],
  };
}

// waitingSince is deliberately excluded: elapsed time must never mint notification
// identities, which would re-notify unchanged PRs and grow client deduplication state.
export function attentionFingerprint(pr: NormalizedPr, attentionState: PrAttentionState): string {
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
        // Clock-free and boolean: replying to one of several threads must not re-notify.
        actionableUnresolvedThreads: pr.actionableUnresolvedThreadCount > 0,
      }),
    )
    .digest("hex");
}

export function isSnoozed(snoozedUntil: string | null): boolean {
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

export function sortTrackedPrs(prs: ReadonlyArray<TrackedPullRequest>): TrackedPullRequest[] {
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

export function buildTrackedPullRequest(
  pr: NormalizedPr,
  viewerLogin: string,
  previous: ViewerStateRow | undefined,
): TrackedPullRequest {
  const raw = {
    actionableUnresolvedThreadCount: pr.actionableUnresolvedThreadCount,
    headRefOid: pr.headRefOid,
    viewerLastReviewedCommitOid: pr.viewerLastReviewedCommitOid,
    author: pr.author,
    isAuthor: pr.author?.toLowerCase() === viewerLogin.toLowerCase(),
    repositoryArchived: pr.repositoryArchived,
    isDraft: pr.isDraft,
    state: pr.state,
    checkRollup: pr.checkRollup,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    mergeRequirements: pr.mergeRequirements,
    mergePermission: pr.mergePermission,
    reviewDecision: pr.reviewDecision,
    viewerHasReviewed: pr.viewerHasReviewed,
    viewerReviewRequested: pr.viewerReviewRequested,
    roles: pr.roles,
  };
  const derivation = derivePrAttention(raw);
  const reasons = derivePrAttentionReasons(raw, {
    at: pr.lastVerifiedAt ?? new Date().toISOString(),
    url: pr.url,
    verified: pr.lastVerifiedAt !== null,
    previous: previous ? parsePayload(previous.viewer_payload_json).reasons : undefined,
    evidence: pr.reasonEvidence,
  });
  const fingerprint = attentionFingerprint(pr, derivation.attentionState);
  const snoozedUntil = previous?.snoozed_until ?? null;
  const ignoredAt = previous?.ignored_at ?? null;
  const snoozed = isSnoozed(snoozedUntil);
  const lastNotified = previous?.last_notified_fingerprint ?? null;
  const lastSeen = previous?.last_seen_fingerprint ?? null;
  const notificationPending =
    !pr.repositoryArchived &&
    derivation.attentionBucket === "needs_you" &&
    !snoozed &&
    ignoredAt === null &&
    fingerprint !== lastNotified &&
    fingerprint !== lastSeen &&
    fingerprint !== previous?.last_acknowledged_fingerprint;

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
    repositoryArchived: pr.repositoryArchived,
    isDraft: pr.isDraft,
    state: pr.state,
    roles: [...pr.roles],
    reasons,
    manuallyTracked: previous
      ? (parsePayload(previous.viewer_payload_json).manuallyTracked ?? false)
      : false,
    attentionState: derivation.attentionState,
    attentionBucket: derivation.attentionBucket,
    ...prAttentionText(reasons[0]!.code, pr.actionableUnresolvedThreadCount),
    mergeRequirements: pr.mergeRequirements,
    mergePermission: pr.mergePermission,
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
    reasonEvidenceTruncated:
      pr.reasonEvidenceTruncated || reasons.some((reason) => reason.evidenceTruncated),
    reviewFactsComplete: pr.reviewFactsComplete,
    actionableUnresolvedThreadCount: pr.actionableUnresolvedThreadCount,
    lastVerifiedAt: pr.lastVerifiedAt,
    waitingSince: derivePrWaitingSince(pr),
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
    acknowledgedAt:
      previous?.last_acknowledged_fingerprint === fingerprint
        ? (previous.acknowledged_at ?? null)
        : null,
    notificationPending,
    attentionFingerprint: fingerprint,
  };
}

export function normalizeGraphqlPr(input: {
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
  const requestAliasesTrusted = reviewRequests.length >= 20;
  const roleSet = new Set<PrViewerRole>();
  if (input.aliases.has("author") || authorLogin?.toLowerCase() === viewerLoginLower) {
    roleSet.add("author");
  }
  if ((requestAliasesTrusted && input.aliases.has("review_requested")) || directReviewRequested) {
    roleSet.add("review_requested");
  }
  if ((requestAliasesTrusted && input.aliases.has("team_review")) || teamReviewRequested) {
    roleSet.add("team_review_requested");
  }
  if (input.aliases.has("assignee")) roleSet.add("assignee");
  if (input.aliases.has("mentioned")) roleSet.add("mentioned");
  if (input.aliases.has("involved")) roleSet.add("involved");

  return {
    lastVerifiedAt: new Date().toISOString(),
    nodeId: stringValue(input.node.id),
    number,
    title,
    url,
    repository: repositoryFromNameWithOwner(nameWithOwner),
    host: input.host,
    author: authorLogin,
    repositoryArchived: repositoryNode?.isArchived === true,
    isDraft: booleanValue(input.node.isDraft),
    state: normalizePullRequestState(input.node.state),
    checkRollup: normalizeCheckRollup(statusCheckState(input.node)),
    reviewDecision: normalizeReviewDecision(input.node.reviewDecision),
    mergeable: normalizeMergeable(input.node.mergeable),
    mergeStateStatus: stringValue(input.node.mergeStateStatus)?.toUpperCase() ?? "UNKNOWN",
    mergeRequirements:
      (input.node.prHubMergeRequirements as TrackedPullRequest["mergeRequirements"]) ??
      unknownMergeRequirements(),
    mergePermission: ["ADMIN", "MAINTAIN", "WRITE"].includes(
      stringValue(asRecord(input.node.repository)?.viewerPermission) ?? "",
    )
      ? "allowed"
      : ["READ", "TRIAGE"].includes(
            stringValue(asRecord(input.node.repository)?.viewerPermission) ?? "",
          )
        ? "denied"
        : "unknown",
    viewerHasReviewed: viewerHasReviewed(input.node, input.viewerLogin),
    viewerReviewRequested:
      (requestAliasesTrusted &&
        (input.aliases.has("review_requested") || input.aliases.has("team_review"))) ||
      directReviewRequested ||
      teamReviewRequested,
    reviewRequestReviewers: reviewRequests,
    reviewRequestsCount: reviewRequests.length,
    commentsCount: numberValue(asRecord(input.node.comments)?.totalCount),
    unresolvedThreadCount: unresolvedThreadCount(input.node),
    reviewFactsComplete: input.node.reviewFactsComplete === true,
    reasonEvidenceTruncated:
      asRecord(input.node.reviewThreads)?.evidenceTruncated === true ||
      asRecord(input.node.latestReviews)?.evidenceTruncated === true,
    actionableUnresolvedThreadCount:
      (typeof asRecord(input.node.reviewThreads)?.actionableCount === "number"
        ? numberValue(asRecord(input.node.reviewThreads)?.actionableCount)
        : null) ?? actionableUnresolvedThreads(input.node, input.viewerLogin).length,
    reasonEvidence: reviewReasonEvidence(input.node, input.viewerLogin),
    viewerLastReviewedCommitOid: stringValue(
      asRecord(viewerLatestReview(input.node, input.viewerLogin)?.commit)?.oid,
    ),
    headCommittedAt: stringValue(
      asRecord(nodeArray(input.node.commits).at(-1)?.commit)?.committedDate,
    ),
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

export function normalizeFallbackPr(input: {
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
    lastVerifiedAt: null,
    nodeId: null,
    number,
    title,
    url,
    repository: repositoryFromNameWithOwner(nameWithOwner),
    host: input.host,
    author: authorLogin,
    repositoryArchived: false,
    isDraft: booleanValue(input.node.isDraft),
    state: normalizePullRequestState(input.node.state),
    checkRollup: "pending",
    reviewDecision: "none",
    mergeable: "unknown",
    mergeStateStatus: "UNKNOWN",
    mergePermission: "unknown",
    viewerHasReviewed: false,
    viewerReviewRequested: input.aliases.has("review_requested"),
    reviewRequestReviewers: [],
    reviewRequestsCount: input.aliases.has("review_requested") ? 1 : 0,
    commentsCount: numberValue(input.node.commentsCount),
    unresolvedThreadCount: 0,
    reviewFactsComplete: false,
    actionableUnresolvedThreadCount: 0,
    viewerLastReviewedCommitOid: null,
    headCommittedAt: null,
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

const SEARCH_VARIABLES = {
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

export interface PrHubSearchBucket {
  alias: keyof typeof SEARCH_VARIABLES;
  query: string;
  updatedSince?: number;
}

export function buildSearchQueries(
  login: string,
  teams: ReadonlyArray<string>,
  now = Date.now(),
): PrHubSearchBucket[] {
  const buckets: PrHubSearchBucket[] = [
    { alias: "review_requested", query: `${SEARCH_OPEN_PREFIX} review-requested:${login}` },
  ];
  const normalizedTeams = teams.map((team) => team.trim()).filter(Boolean);
  const teamAliases = (Object.keys(SEARCH_VARIABLES) as PrHubSearchBucket["alias"][]).filter(
    (alias) => alias.startsWith("team_review_"),
  );
  for (const [index, alias] of teamAliases.entries()) {
    const chunk = normalizedTeams.slice(
      index * TEAM_QUERY_CHUNK_SIZE,
      (index + 1) * TEAM_QUERY_CHUNK_SIZE,
    );
    if (chunk.length)
      buckets.push({
        alias,
        query: `${SEARCH_OPEN_PREFIX} (${chunk.map((team) => `team-review-requested:${team}`).join(" OR ")})`,
      });
  }
  buckets.push(
    { alias: "author", query: `${SEARCH_OPEN_PREFIX} author:${login}` },
    { alias: "assignee", query: `${SEARCH_OPEN_PREFIX} assignee:${login}` },
    { alias: "mentioned", query: `${SEARCH_OPEN_PREFIX} mentions:${login}` },
    { alias: "involved", query: `${SEARCH_OPEN_PREFIX} involves:${login}` },
    {
      alias: "recently_closed",
      query: `is:pr -is:open author:${login} archived:false ${SEARCH_SORT_QUALIFIER}`,
      updatedSince: Math.floor(now / 86_400_000) * 86_400_000 - 7 * 86_400_000,
    },
  );
  return buckets;
}

/** Only fixed internal aliases enter the document; search text stays in variables. */
export function buildPrHubSearchRequest(buckets: readonly PrHubSearchBucket[]) {
  const variables: Record<string, string> = {};
  const fields: string[] = [];
  for (const alias of Object.keys(SEARCH_VARIABLES) as PrHubSearchBucket["alias"][]) {
    const bucket = buckets.find((candidate) => candidate.alias === alias);
    if (!bucket) continue;
    const variable = SEARCH_VARIABLES[alias];
    variables[variable] = bucket.query;
    fields.push(
      `${alias}: search(query:$${variable},type:ISSUE,first:100){ issueCount pageInfo { hasNextPage endCursor } nodes{ ...PrSearchFields } }`,
    );
  }
  if (!fields.length) throw new Error("PR Hub search requires an active bucket.");
  return {
    document: `query PrHubSearch(${Object.keys(variables)
      .map((name) => `$${name}:String!`)
      .join(",")}) {
      ${fields.join("\n")}
      rateLimit { cost remaining limit resetAt }
    }
    fragment PrSearchFields on PullRequest { id updatedAt repository { nameWithOwner } }`,
    variables,
  };
}

export const PR_HUB_DETAILS_QUERY = `
query PrHubDetails($ids:[ID!]!){
  nodes(ids:$ids){
    ... on PullRequest {
      ...PrFields
    }
  }
  rateLimit { cost remaining limit resetAt }
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
  baseRefOid
  headRefName
  headRefOid
  additions
  deletions
  changedFiles
  author { login }
  repository { nameWithOwner isPrivate isArchived viewerPermission }
  ${PR_HUB_BRANCH_REQUIREMENTS_FIELDS}
  labels(first:10){ nodes { name } }
  assignees(first:10){ nodes { login } }
  comments { totalCount }
  reviewThreads(first:50){ totalCount pageInfo { hasNextPage endCursor } nodes { ${ATTENTION_CONNECTION_FIELDS.reviewThreads} } }
  reviewRequests(first:20){ nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  latestReviews(first:50){ totalCount pageInfo { hasNextPage endCursor } nodes { ${ATTENTION_CONNECTION_FIELDS.latestReviews} } }
  commits(last:1){ nodes { commit { committedDate statusCheckRollup { state contexts(first:100){ totalCount pageInfo { hasNextPage endCursor } nodes {
    ... on CheckRun { id name detailsUrl conclusion status checkSuite { app { databaseId } } }
    ... on StatusContext { id context targetUrl state }
  } } } } } }
}
`;

export const PR_HUB_RECONCILE_QUERY = `
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
  rateLimit { cost remaining limit resetAt }
}
`;

export function buildReconcileByNumberRequest(
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
