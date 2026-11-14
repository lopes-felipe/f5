import type {
  PrAttentionBucket,
  PrAttentionReason,
  PrHubListFilter,
  PrHubListInput,
  PrHubSection,
  PrAttentionState,
  PrCheckRollup,
  PrMergeable,
  PrReviewDecision,
  PrReviewRequestSource,
  PrViewerRole,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { PR_HUB_STALE_AFTER_DAYS_DEFAULT } from "@t3tools/contracts";

export interface RawPrFields {
  readonly mergeRequirements?: TrackedPullRequest["mergeRequirements"] | undefined;
  readonly repositoryArchived?: boolean | undefined;
  readonly actionableUnresolvedThreadCount: number;
  readonly headRefOid: string | null;
  readonly viewerLastReviewedCommitOid: string | null;
  readonly author?: string | null | undefined;
  readonly isAuthor?: boolean | undefined;
  readonly isDraft: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly checkRollup: PrCheckRollup;
  readonly mergeable: PrMergeable;
  readonly mergeStateStatus: string;
  readonly mergePermission?: "allowed" | "denied" | "unknown" | undefined;
  readonly reviewDecision: PrReviewDecision;
  readonly viewerHasReviewed: boolean;
  readonly viewerReviewRequested: boolean;
  /** Absent means the forge cannot tell, which counts as a request to the viewer. */
  readonly reviewRequestSource?: PrReviewRequestSource | null | undefined;
  readonly roles: ReadonlyArray<PrViewerRole>;
}

export interface PrAttentionDerivation {
  readonly attentionState: PrAttentionState;
  readonly attentionBucket: PrAttentionBucket;
  readonly primaryReason: string;
  readonly nextAction: string;
}

export const PR_HUB_NEEDS_YOU_STATES: ReadonlySet<PrAttentionState> = new Set([
  "ci_failing",
  "merge_conflict",
  "branch_behind",
  "changes_requested",
  "unresolved_comments",
  "changes_pushed",
  "ready_to_merge",
  "review_requested",
  "re_review_requested",
]);

function isFailureRollup(checkRollup: PrCheckRollup): boolean {
  return checkRollup === "failure" || checkRollup === "error";
}

function isPassingOrNoChecks(checkRollup: PrCheckRollup): boolean {
  return checkRollup === "success" || checkRollup === "none";
}

function isDirtyMergeState(mergeStateStatus: string): boolean {
  return mergeStateStatus.trim().toUpperCase() === "DIRTY";
}

function isBehindMergeState(mergeStateStatus: string): boolean {
  return mergeStateStatus.trim().toUpperCase() === "BEHIND";
}

/** Display strings are projected from persisted reason codes, never a second classifier. */
export function prAttentionText(
  code: PrAttentionReason["code"],
  actionableCount = 0,
): Pick<PrAttentionDerivation, "primaryReason" | "nextAction"> {
  const labels: Record<PrAttentionReason["code"], readonly [string, string]> = {
    repository_archived: ["Archived repository", "Read-only — repository archived"],
    merge_calculating: [
      "Merge state is being calculated",
      "GitHub is still calculating merge readiness",
    ],
    merge_blocked: [
      "Merge blocked by repository requirements",
      "Wait for repository requirements to be satisfied",
    ],
    merge_permission: [
      "Maintainer merge required",
      "Ask a maintainer with merge permission to merge",
    ],
    ci_pending: ["CI running", "Wait for CI to finish"],
    merged: ["Merged", "Merged"],
    closed: ["Closed without merge", "Closed without merge"],
    draft: ["Draft", "Draft - finish and mark ready"],
    ci_failing: ["CI failing", "Fix failing CI"],
    merge_conflict: ["Merge conflicts", "Resolve merge conflicts"],
    branch_behind: ["Branch behind", "Update branch"],
    changes_requested: ["Changes requested", "Address requested changes"],
    ready_to_merge: ["Ready to merge", "Ready to merge"],
    unresolved_comments: [
      "Unresolved review comments",
      `Address ${actionableCount} unresolved review comment${actionableCount === 1 ? "" : "s"}`,
    ],
    awaiting_review: ["Awaiting review", "Waiting on reviewers"],
    review_requested: ["Review requested", "Review requested"],
    re_review_requested: ["Re-review requested", "Re-review requested"],
    team_review_requested: ["Review requested from your team", "Review requested from your team"],
    changes_pushed: ["Changes pushed since your review", "Review new changes"],
    reviewed_waiting: ["You reviewed", "You reviewed - waiting on author"],
    mentioned: ["You're involved", "You're involved"],
  };
  const [primaryReason, nextAction] = labels[code];
  return { primaryReason, nextAction };
}

function attentionCodes(input: RawPrFields): PrAttentionState[] {
  const isAuthor = input.isAuthor === true || input.roles.includes("author");
  if (input.state === "merged") return ["merged"];
  if (input.state === "closed") return ["closed"];
  if (input.repositoryArchived) return ["mentioned"];
  if (isAuthor && input.isDraft) return ["draft"];
  const codes: PrAttentionState[] = [];
  if (isAuthor) {
    if (isFailureRollup(input.checkRollup)) codes.push("ci_failing");
    if (input.mergeable === "conflicting" || isDirtyMergeState(input.mergeStateStatus))
      codes.push("merge_conflict");
    if (isBehindMergeState(input.mergeStateStatus)) codes.push("branch_behind");
    if (input.reviewDecision === "changes_requested") codes.push("changes_requested");
    if (
      input.mergeRequirements?.verification === "verified" &&
      input.mergeRequirements.mandatorySatisfied &&
      input.reviewDecision === "approved" &&
      isPassingOrNoChecks(input.checkRollup) &&
      input.mergeable === "mergeable" &&
      input.mergePermission === "allowed" &&
      input.mergeStateStatus.trim().toUpperCase() === "CLEAN"
    )
      codes.push("ready_to_merge");
    if (input.actionableUnresolvedThreadCount > 0) codes.push("unresolved_comments");
    return codes.length ? codes : ["awaiting_review"];
  }
  // A request to one of the viewer's teams is somebody's job, not necessarily the viewer's.
  const teamOnly = input.viewerReviewRequested && input.reviewRequestSource === "team";
  if (input.viewerReviewRequested && !teamOnly)
    codes.push(input.viewerHasReviewed ? "re_review_requested" : "review_requested");
  if (
    input.viewerHasReviewed &&
    input.headRefOid !== null &&
    input.viewerLastReviewedCommitOid !== null &&
    input.headRefOid !== input.viewerLastReviewedCommitOid
  )
    codes.push("changes_pushed");
  if (codes.length) return codes;
  if (teamOnly) return ["team_review_requested"];
  return [input.viewerHasReviewed ? "reviewed_waiting" : "mentioned"];
}

export function derivePrAttention(input: RawPrFields): PrAttentionDerivation {
  const attentionState = attentionCodes(input)[0]!;
  const attentionBucket = PR_HUB_NEEDS_YOU_STATES.has(attentionState)
    ? "needs_you"
    : attentionState === "awaiting_review" || attentionState === "reviewed_waiting"
      ? "waiting_on_others"
      : "informational";
  return {
    attentionState,
    attentionBucket,
    ...prAttentionText(attentionState, input.actionableUnresolvedThreadCount),
  };
}

/** Clock-free classification with stable evidence observation times across refreshes. */
export function derivePrAttentionReasons(
  input: RawPrFields,
  observation: {
    at: string;
    url: string;
    verified: boolean;
    previous?: readonly PrAttentionReason[] | undefined;
    evidence?:
      | Partial<Record<PrAttentionReason["code"], readonly { id: string; url: string }[]>>
      | undefined;
  },
): PrAttentionReason[] {
  const codes: PrAttentionReason["code"][] = attentionCodes(input);
  if (input.repositoryArchived && input.state === "open")
    codes.splice(0, codes.length, "repository_archived");
  if (
    (input.isAuthor || input.roles.includes("author")) &&
    !input.repositoryArchived &&
    input.state === "open" &&
    !input.isDraft
  ) {
    const extra: PrAttentionReason["code"][] = [];
    if (input.checkRollup === "pending") extra.push("ci_pending");
    if (input.reviewDecision === "approved") {
      if (
        input.mergeRequirements?.verification !== "verified" ||
        !input.mergeRequirements.mandatorySatisfied
      )
        extra.push("merge_blocked");
      if (
        input.mergeable === "unknown" ||
        !input.mergeStateStatus ||
        input.mergeStateStatus === "UNKNOWN"
      )
        extra.push("merge_calculating");
      else if (["BLOCKED", "HAS_HOOKS", "UNSTABLE"].includes(input.mergeStateStatus))
        extra.push("merge_blocked");
      if (input.mergePermission !== "allowed") extra.push("merge_permission");
    }
    if (extra.length && codes[0] === "awaiting_review" && input.reviewDecision === "approved")
      codes.shift();
    codes.push(...new Set(extra));
  }
  let evidenceBudget = 50;
  return codes.map((code) => {
    const actor: PrAttentionReason["actor"] =
      code === "ci_pending"
        ? "ci"
        : code === "merge_calculating" || code === "merge_blocked" || code === "repository_archived"
          ? "policy"
          : code === "merge_permission"
            ? "reviewer"
            : code === "awaiting_review" || code === "team_review_requested"
              ? "reviewer"
              : code === "reviewed_waiting"
                ? "author"
                : code === "mentioned"
                  ? "unknown"
                  : code === "merged" || code === "closed"
                    ? "unknown"
                    : "viewer";
    const action: PrAttentionReason["action"] =
      code === "ready_to_merge"
        ? "merge"
        : code === "review_requested" ||
            code === "re_review_requested" ||
            code === "team_review_requested" ||
            code === "changes_pushed"
          ? "review"
          : code === "awaiting_review" ||
              code === "reviewed_waiting" ||
              code === "ci_pending" ||
              code === "merge_calculating" ||
              code === "merge_blocked" ||
              code === "merge_permission"
            ? "wait"
            : code === "draft"
              ? "finish"
              : PR_HUB_NEEDS_YOU_STATES.has(code as PrAttentionState)
                ? "fix"
                : "none";
    const supplied = observation.evidence?.[code];
    const allEvidence = supplied?.length
      ? [...supplied].sort((a, b) => a.id.localeCompare(b.id))
      : [{ id: `${code}:${input.headRefOid ?? "unknown"}`, url: observation.url }];
    const evidence = allEvidence.slice(0, evidenceBudget);
    evidenceBudget -= evidence.length;
    const previous = observation.previous?.find(
      (reason) =>
        reason.code === code &&
        reason.actor === actor &&
        JSON.stringify(reason.evidence) === JSON.stringify(evidence),
    );
    return {
      code,
      actor,
      action,
      evidence,
      evidenceTruncated: allEvidence.length > evidence.length,
      firstObservedAt: previous?.firstObservedAt ?? observation.at,
      verification:
        observation.verified &&
        !(code === "merge_permission" && input.mergePermission === "unknown")
          ? "verified"
          : "unverified",
    };
  });
}

/** Data-only timestamp; never participates in attention state or notification identity. */
export function derivePrWaitingSince(
  input: Pick<
    TrackedPullRequest,
    | "roles"
    | "state"
    | "isDraft"
    | "viewerReviewRequested"
    | "viewerHasReviewed"
    | "createdAt"
    | "updatedAt"
  > & { readonly headCommittedAt: string | null },
): string | null {
  if (input.state !== "open") return null;
  if (input.roles.includes("author"))
    return input.isDraft ? null : (input.headCommittedAt ?? input.createdAt);
  return input.viewerReviewRequested || input.viewerHasReviewed
    ? (input.headCommittedAt ?? input.updatedAt)
    : null;
}

export function canViewerReview(
  pr: Pick<
    TrackedPullRequest,
    "state" | "roles" | "viewerReviewRequested" | "attentionState" | "repositoryArchived"
  >,
): boolean {
  return (
    !pr.repositoryArchived &&
    pr.state === "open" &&
    !pr.roles.includes("author") &&
    (pr.viewerReviewRequested || pr.attentionState === "changes_pushed")
  );
}

/** Queue sections in display order; this is also the first key of the priority sort. */
export const PR_HUB_SECTIONS: readonly PrHubSection[] = [
  "review",
  "action",
  "ready",
  "waiting",
  "drafts",
  "team",
  "other",
  "stale",
];

/** The sections that make up "needs you": the sidebar badge and notifications. */
export const PR_HUB_NEEDS_YOU_SECTIONS: ReadonlySet<PrHubSection> = new Set([
  "review",
  "action",
  "ready",
]);

/**
 * Where an open pull request belongs in the queue; first match wins. Snooze and ignore
 * are visibility, not classification, so callers filter those separately.
 */
export function prHubSection(
  pr: Pick<
    TrackedPullRequest,
    | "state"
    | "roles"
    | "isDraft"
    | "updatedAt"
    | "attentionState"
    | "attentionBucket"
    | "viewerReviewRequested"
    | "reviewRequestSource"
    | "repositoryArchived"
  >,
  options: { readonly now: number; readonly staleAfterDays: number },
): PrHubSection {
  if (pr.state !== "open" || pr.repositoryArchived) return "other";
  const updatedAt = Date.parse(pr.updatedAt);
  if (
    options.staleAfterDays > 0 &&
    Number.isFinite(updatedAt) &&
    options.now - updatedAt > options.staleAfterDays * 86_400_000
  )
    return "stale";
  const isAuthor = pr.roles.includes("author");
  if (!isAuthor) {
    if (
      (pr.viewerReviewRequested && pr.reviewRequestSource !== "team") ||
      pr.attentionState === "changes_pushed" ||
      pr.attentionState === "re_review_requested" ||
      pr.attentionBucket === "needs_you"
    )
      return "review";
  } else {
    if (pr.attentionState === "ready_to_merge") return "ready";
    if (pr.attentionBucket === "needs_you") return "action";
    if (pr.isDraft) return "drafts";
  }
  if (pr.attentionBucket === "waiting_on_others") return "waiting";
  if (pr.attentionState === "team_review_requested") return "team";
  return "other";
}

/** The section stamped when the snapshot was read, or a fresh one for rows without it. */
export function prHubSectionOf(pr: TrackedPullRequest, now = Date.now()): PrHubSection {
  return pr.section ?? prHubSection(pr, { now, staleAfterDays: PR_HUB_STALE_AFTER_DAYS_DEFAULT });
}

/**
 * Within a bucket, order by how actionable / pressing the attention state is.
 * Lower rank sorts first. Keep this switch exhaustive when adding states.
 */
function stateSeverityRank(pr: TrackedPullRequest): number {
  switch (pr.attentionState) {
    case "merge_conflict":
      return 0;
    case "ci_failing":
      return 1;
    case "branch_behind":
      return 2;
    case "changes_requested":
      return 3;
    case "unresolved_comments":
      return 4;
    case "changes_pushed":
      return 5;
    case "re_review_requested":
      return 6;
    case "review_requested":
      return 7;
    case "ready_to_merge":
      return 8;
    case "awaiting_review":
      return 9;
    case "reviewed_waiting":
      return 10;
    case "draft":
      return 11;
    case "team_review_requested":
      return 12;
    case "mentioned":
      return 13;
    case "merged":
      return 14;
    case "closed":
      return 15;
  }
}

/**
 * Total ordering for the queue: section order, then how pressing the state is, then most
 * recently updated. Recency replaced longest-waiting-first, which put fossils on top.
 */
export function comparePrPriority(
  a: TrackedPullRequest,
  b: TrackedPullRequest,
  now: number = Date.now(),
): number {
  const bySection =
    PR_HUB_SECTIONS.indexOf(prHubSectionOf(a, now)) -
    PR_HUB_SECTIONS.indexOf(prHubSectionOf(b, now));
  if (bySection !== 0) return bySection;
  const bySeverity = stateSeverityRank(a) - stateSeverityRank(b);
  if (bySeverity !== 0) return bySeverity;
  const aTime = new Date(a.updatedAt).getTime();
  const bTime = new Date(b.updatedAt).getTime();
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return bTime - aTime;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return 0;
}

export function matchesPrHubFilter(
  pr: TrackedPullRequest,
  filter: PrHubListFilter,
  stalledBefore?: string,
  now = Date.now(),
  visibility?: PrHubListInput["visibility"],
): boolean {
  const snoozed = pr.snoozedUntil !== null && Date.parse(pr.snoozedUntil) > now;
  if (filter === "ignored") return pr.ignoredAt !== null;
  if (filter === "recently_resolved") return pr.state !== "open";
  if (visibility) {
    if (visibility === "active" && (pr.state !== "open" || pr.ignoredAt !== null || snoozed))
      return false;
    if (visibility === "snoozed" && (!snoozed || pr.state !== "open" || pr.ignoredAt !== null))
      return false;
    if (visibility === "ignored" && pr.ignoredAt === null) return false;
    if (visibility === "resolved" && pr.state === "open") return false;
  } else {
    if (pr.ignoredAt !== null || pr.state !== "open") return false;
    if (
      snoozed &&
      filter !== "all" &&
      filter !== "authored" &&
      filter !== "reviews" &&
      filter !== "snoozed"
    )
      return false;
  }
  if (filter === "snoozed") return snoozed;
  switch (filter) {
    case "all":
      return true;
    case "needs_you":
      return PR_HUB_NEEDS_YOU_SECTIONS.has(prHubSectionOf(pr, now));
    case "authored":
      return pr.roles.includes("author");
    case "reviews":
      return !pr.roles.includes("author") && (pr.viewerHasReviewed || pr.viewerReviewRequested);
    case "needs_my_review":
      return prHubSectionOf(pr, now) === "review";
    case "my_prs_need_action":
      return pr.roles.includes("author") && PR_HUB_NEEDS_YOU_SECTIONS.has(prHubSectionOf(pr, now));
    case "waiting":
      return pr.attentionBucket === "waiting_on_others";
    case "notification_pending":
      return pr.notificationPending;
    case "stalled":
      return (
        !!stalledBefore &&
        pr.roles.includes("author") &&
        !pr.isDraft &&
        pr.waitingSince !== null &&
        Date.parse(pr.waitingSince) <= Date.parse(stalledBefore)
      );
    default:
      return pr.attentionState === filter;
  }
}
