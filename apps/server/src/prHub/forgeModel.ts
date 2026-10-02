import {
  type ForgeAccount,
  type PrHubDetailResult,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import type { ForgeDetail, ForgeProvider } from "../sourceControl/ForgeSourceControlProvider.ts";
import type { SourceControlPullRequestRef } from "@t3tools/contracts";

export const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const login = (v: unknown) =>
  text(record(v).login) ??
  text(record(v).username) ??
  text(record(v).nickname) ??
  text(record(v).displayName);
const date = (v: unknown, fallback: string) =>
  text(v) && Number.isFinite(Date.parse(String(v))) ? new Date(String(v)).toISOString() : fallback;
export function forgeTracked(
  account: ForgeAccount,
  ref: SourceControlPullRequestRef,
  detail: ForgeDetail,
  provider: ForgeProvider,
): TrackedPullRequest {
  const now = new Date().toISOString();
  const raw = detail.raw;
  const author = login(raw.author ?? raw.user ?? raw.createdBy);
  const draft = raw.draft === true || raw.work_in_progress === true || raw.isDraft === true;
  const state = detail.state ?? "open";
  const pipeline = record(raw.head_pipeline);
  const pipelineStatus = text(pipeline.status)?.toLowerCase();
  const checkRollup: TrackedPullRequest["checkRollup"] =
    pipelineStatus === "success"
      ? "success"
      : pipelineStatus === "failed"
        ? "failure"
        : ["pending", "running", "created", "preparing", "waiting_for_resource"].includes(
              pipelineStatus ?? "",
            )
          ? "pending"
          : "none";
  const reviewers = Array.isArray(raw.reviewers)
    ? raw.reviewers.map(login).filter((name): name is string => name !== null)
    : [];
  const viewerReviewRequested = reviewers.some(
    (name) => name.toLowerCase() === account.login.toLowerCase(),
  );
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((v) => (typeof v === "string" ? v : text(record(v).name)))
        .filter((v): v is string => v !== null)
    : [];
  const roles = forgeUserMatches(raw.author ?? raw.user ?? raw.createdBy, account)
    ? ["author" as const]
    : ["involved" as const];
  return {
    key: formatSourceControlPullRequestKey(ref),
    provider: ref.provider,
    ref,
    capabilities: provider.capabilities,
    forgeCapabilities: provider.forgeCapabilities,
    providerDetails: {
      provider: account.provider as "gitlab" | "bitbucket" | "azure-devops" | "forgejo",
      externalId: String(raw.id ?? ref.number),
    },
    nodeId: null,
    number: ref.number,
    title: detail.title,
    url: detail.url,
    repository: {
      owner: ref.repository.split("/").slice(0, -1).join("/"),
      repo: ref.repository.split("/").at(-1)!,
      nameWithOwner: ref.repository,
    },
    host: ref.host,
    author,
    isDraft: draft,
    state,
    roles,
    attentionState:
      state === "merged"
        ? "merged"
        : state === "closed"
          ? "closed"
          : draft
            ? "draft"
            : "awaiting_review",
    attentionBucket: state === "open" ? "waiting_on_others" : "informational",
    primaryReason: "Provider status; review and merge requirements must be verified on the forge.",
    nextAction: state === "open" ? "Review pull request" : "No action needed",
    checkRollup,
    reviewDecision: "none",
    mergeable: raw.has_conflicts === true ? "conflicting" : "unknown",
    mergeStateStatus: "UNKNOWN",
    mergePermission: "unknown",
    viewerHasReviewed: false,
    viewerReviewRequested,
    reviewRequestReviewers: reviewers,
    reviewRequestsCount: reviewers.length,
    commentsCount:
      typeof raw.user_notes_count === "number" && raw.user_notes_count >= 0
        ? Math.floor(raw.user_notes_count)
        : 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    reviewFactsComplete: false,
    waitingSince: null,
    lastVerifiedAt: now,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: detail.headRefOid ?? null,
    baseRefName: detail.baseRefName,
    headRefName: detail.headRefName,
    allowedMergeMethods: provider.forgeCapabilities.mergeMethods,
    labels,
    assignees: [],
    createdAt: date(raw.created_at ?? raw.created_on ?? raw.createdDate, now),
    updatedAt: date(raw.updated_at ?? raw.updated_on, now),
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: JSON.stringify([state, detail.headRefOid]),
  };
}
export function forgeDetail(pr: TrackedPullRequest, detail: ForgeDetail): PrHubDetailResult {
  return {
    detail: {
      key: pr.key,
      providerDetails: pr.providerDetails as Exclude<
        NonNullable<TrackedPullRequest["providerDetails"]>,
        { provider: "github" }
      >,
      title: pr.title,
      body: detail.body,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: null,
      closedAt: null,
      author: pr.author ? { login: pr.author, name: null, avatarUrl: null } : null,
      labels: pr.labels.map((name) => ({ name, color: null, description: null })),
      reviewers: [],
      checks: [],
      reactions: [],
    },
    stale: false,
    refreshedAt: new Date().toISOString(),
  };
}

/** Native discussion shapes retain only actual inline locations and resolution facts. */
export function forgeReviewThreads(
  values: readonly Readonly<Record<string, unknown>>[],
  provider: ForgeProvider,
): import("@t3tools/contracts").PrHubReviewThread[] {
  return values.flatMap((value) => {
    const comments = Array.isArray(value.notes)
      ? value.notes.map(record)
      : Array.isArray(value.comments)
        ? value.comments.map(record)
        : [value];
    const inline = comments.filter(
      (comment) =>
        comment.system !== true &&
        comment.isDeleted !== true &&
        (record(comment.position).new_path ||
          record(comment.position).old_path ||
          record(comment.inline).path ||
          comment.path ||
          record(value.threadContext).filePath),
    );
    if (!inline.length) return [];
    const first = inline[0]!;
    const position = record(first.position),
      location = record(first.inline),
      context = record(value.threadContext);
    const numericLine = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
    const line = numericLine(
      position.new_line ??
        position.old_line ??
        location.to ??
        location.from ??
        first.line ??
        record(context.rightFileStart).line,
    );
    const path = text(
      position.new_path ?? position.old_path ?? location.path ?? first.path ?? context.filePath,
    );
    return [
      {
        id: String(value.id ?? first.id),
        isResolved:
          value.resolved === true ||
          inline.every((comment) => comment.resolvable === true && comment.resolved === true),
        path,
        line,
        originalLine: line,
        viewerCanReply: provider.forgeCapabilities.review.reply,
        viewerCanResolve: provider.forgeCapabilities.review.resolve,
        viewerCanUnresolve: provider.forgeCapabilities.review.resolve,
        comments: inline.map((comment) => ({
          id: String(comment.id),
          url: text(comment.html_url ?? comment.web_url) ?? "",
          author: login(comment.author ?? comment.user),
          bodyText:
            text(comment.body) ?? text(record(comment.content).raw) ?? text(comment.content) ?? "",
          body:
            text(comment.body) ?? text(record(comment.content).raw) ?? text(comment.content) ?? "",
          createdAt: text(comment.created_at ?? comment.created_on ?? comment.publishedDate),
          updatedAt: text(comment.updated_at ?? comment.updated_on),
          outdated: comment.outdated === true,
          diffHunk: text(comment.diff_hunk),
        })),
      },
    ];
  });
}

/** Unknown merge bases remain empty; only native commit IDs pin viewed marks and inline drafts. */
export function forgeComparison(
  ref: SourceControlPullRequestRef,
  detail: ForgeDetail,
): import("@t3tools/contracts").PrHubComparisonIdentity | null {
  const raw = detail.raw,
    diff = record(raw.diff_refs),
    base = record(raw.base),
    head = record(raw.head);
  const destination = record(raw.destination);
  const headOid = text(diff.head_sha) ?? detail.headRefOid ?? text(head.sha);
  const baseOid =
    text(diff.start_sha) ??
    text(diff.base_sha) ??
    text(base.sha) ??
    text(record(destination.commit).hash) ??
    text(record(raw.lastMergeTargetCommit).commitId);
  if (!headOid || !baseOid || !detail.baseRefName || !detail.headRefName) return null;
  return {
    baseRepository: ref.repository,
    baseRef: detail.baseRefName,
    baseOid,
    headRepository: detail.headRepositoryNameWithOwner ?? ref.repository,
    headRef: detail.headRefName,
    headOid,
    mergeBaseOid: text(diff.base_sha) ?? "",
    mode: "current_pr",
  };
}

export function forgeUserMatches(value: unknown, account: ForgeAccount): boolean {
  const user = record(value);
  const id = user.id ?? user.uuid ?? user.account_id;
  if (typeof id === "string" || typeof id === "number") return String(id) === account.viewerId;
  const handle = text(user.login ?? user.username ?? user.nickname);
  return !!handle && handle.toLowerCase() === account.login.toLowerCase();
}
