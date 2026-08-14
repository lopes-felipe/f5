import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  GitMergeIcon,
  MinusCircleIcon,
  RefreshCwIcon,
  SendIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type {
  PrHubAdvisory,
  PrHubAdvisoryRecommendation,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { resolveSnoozePreset } from "../../lib/snoozePresets";

import { ensureNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import type { Badge } from "../ui/badge";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

export function attentionVariant(pr: TrackedPullRequest): BadgeVariant {
  if (pr.attentionState === "ready_to_merge") return "success";
  if (pr.attentionBucket === "needs_you") return "warning";
  if (pr.attentionBucket === "waiting_on_others") return "info";
  if (pr.state !== "open") return "secondary";
  return "outline";
}

/**
 * Color for the row's left accent rail. Mirrors {@link attentionVariant}'s
 * branch order exactly so the rail and the attention badge never disagree.
 */
export function attentionAccentClass(pr: TrackedPullRequest): string {
  if (pr.attentionState === "ready_to_merge") return "bg-success";
  if (pr.attentionBucket === "needs_you") return "bg-warning";
  if (pr.attentionBucket === "waiting_on_others") return "bg-info";
  if (pr.state !== "open") return "bg-muted-foreground/40";
  return "bg-border";
}

export function checkLabel(checkRollup: TrackedPullRequest["checkRollup"]): string {
  switch (checkRollup) {
    case "success":
      return "CI passed";
    case "failure":
      return "CI failed";
    case "error":
      return "CI error";
    case "pending":
      return "CI pending";
    case "none":
      return "No CI";
  }
}

export function checkIconFor(checkRollup: TrackedPullRequest["checkRollup"]): {
  Icon: LucideIcon;
  className: string;
} {
  switch (checkRollup) {
    case "success":
      return { Icon: CheckCircle2Icon, className: "text-success-foreground" };
    case "failure":
      return { Icon: XCircleIcon, className: "text-destructive-foreground" };
    case "error":
      return { Icon: AlertCircleIcon, className: "text-destructive-foreground" };
    case "pending":
      return { Icon: ClockIcon, className: "text-warning-foreground" };
    case "none":
      return { Icon: MinusCircleIcon, className: "text-muted-foreground" };
  }
}

export type PrimaryActionKind = "approve" | "merge" | "markReady" | "reRequest";

export interface PrimaryActionDescriptor {
  kind: PrimaryActionKind;
  label: string;
  Icon: LucideIcon;
}

/**
 * The single contextual primary action for a row, derived from the same
 * conditions the row uses to gate its buttons. Returns null when no primary
 * action applies (closed/merged/ignored, or nothing actionable).
 */
export function primaryActionFor(
  pr: TrackedPullRequest,
  flags: { isAuthor: boolean; isOpen: boolean; isIgnored: boolean },
): PrimaryActionDescriptor | null {
  const { isAuthor, isOpen, isIgnored } = flags;
  if (!isOpen || isIgnored) return null;

  const canReview =
    !isAuthor &&
    (pr.attentionState === "review_requested" || pr.attentionState === "re_review_requested");
  if (canReview) return { kind: "approve", label: "Approve", Icon: CheckIcon };

  if (isAuthor && pr.attentionState === "ready_to_merge") {
    return { kind: "merge", label: "Merge", Icon: GitMergeIcon };
  }
  if (isAuthor && pr.attentionState === "draft") {
    return { kind: "markReady", label: "Ready", Icon: SendIcon };
  }
  if (isAuthor && pr.attentionState === "awaiting_review" && pr.reviewRequestReviewers.length > 0) {
    return { kind: "reRequest", label: "Re-request", Icon: RefreshCwIcon };
  }
  return null;
}

export interface PrRowActionVisibility {
  /** The single contextual primary action, or null when none applies. */
  primary: PrimaryActionDescriptor | null;
  /** Reviewer is asked to review → Comment / Request changes are offered. */
  canReview: boolean;
  /** Snooze / Unsnooze group is available. */
  canSnooze: boolean;
  /** "Suggest actions" is available (also requires an analyze callback). */
  canSuggest: boolean;
  /** Ignore is available. */
  canIgnore: boolean;
}

/**
 * Single source of truth for which actions a row exposes. Derives the primary
 * action and the overflow-menu item visibility from one place so the row, the
 * actions component, and any future consumer cannot drift out of sync.
 */
export function prRowActionVisibility(
  pr: TrackedPullRequest,
  flags: { isAuthor: boolean; isOpen: boolean; isIgnored: boolean },
): PrRowActionVisibility {
  const { isAuthor, isOpen, isIgnored } = flags;
  const actionable = isOpen && !isIgnored;
  const canReview =
    actionable &&
    !isAuthor &&
    (pr.attentionState === "review_requested" || pr.attentionState === "re_review_requested");
  return {
    primary: primaryActionFor(pr, flags),
    canReview,
    canSnooze: actionable,
    canSuggest: actionable,
    canIgnore: actionable,
  };
}

export function advisoryRecommendationLabel(recommendation: PrHubAdvisoryRecommendation): string {
  switch (recommendation) {
    case "fix_ci":
      return "Fix CI";
    case "wait_for_ci":
      return "Wait for CI";
    case "resolve_conflicts":
      return "Resolve conflicts";
    case "address_review_feedback":
      return "Address feedback";
    case "clarify_feedback":
      return "Clarify feedback";
    case "wait_for_reviewers":
      return "Wait for reviewers";
    case "re_request_review":
      return "Re-request review";
    case "ready_to_merge":
      return "Ready to merge";
    case "review_requested":
      return "Review requested";
    case "no_action":
      return "No action";
  }
}

export function advisoryVariant(advisory: PrHubAdvisory): BadgeVariant {
  if (advisory.status === "failed") return "error";
  if (advisory.status === "stale") return "warning";
  if (advisory.status === "queued" || advisory.status === "running") return "info";
  switch (advisory.recommendation) {
    case "fix_ci":
    case "resolve_conflicts":
    case "address_review_feedback":
      return "warning";
    case "ready_to_merge":
      return "success";
    case "wait_for_ci":
    case "wait_for_reviewers":
    case "review_requested":
    case "re_request_review":
    case "clarify_feedback":
      return "info";
    case "no_action":
      return "secondary";
  }
}

export function advisoryStatusLabel(advisory: PrHubAdvisory): string | null {
  if (advisory.status === "queued") return "Queued";
  if (advisory.status === "running") return "Running";
  if (advisory.status === "stale") return "Stale";
  if (advisory.degraded) return "Degraded";
  if (advisory.truncated) return "Truncated";
  return null;
}

export function reviewDecisionLabel(decision: TrackedPullRequest["reviewDecision"]): string {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Review required";
    case "none":
      return "No reviews";
  }
}

export function mergeableLabel(mergeable: TrackedPullRequest["mergeable"]): string {
  switch (mergeable) {
    case "mergeable":
      return "Mergeable";
    case "conflicting":
      return "Conflicts";
    case "unknown":
      return "Unknown";
  }
}

export function defaultSnoozeUntil(): string {
  return resolveSnoozePreset("three-hours");
}

/** The two layouts the PR Hub can render. Persisted per-user in localStorage. */
export type PrHubViewMode = "inbox" | "focus";

export const PR_HUB_VIEW_MODE_STORAGE_KEY = "f5.prHub.viewMode";

/**
 * Attention buckets, ordered by how much they demand the viewer's attention.
 * Lower rank sorts first (more urgent).
 */
function bucketRank(pr: TrackedPullRequest): number {
  switch (pr.attentionBucket) {
    case "needs_you":
      return 0;
    case "waiting_on_others":
      return 1;
    default:
      return 2;
  }
}

/**
 * Within a bucket, order by how actionable / pressing the attention state is.
 * Lower rank sorts first. States not listed fall to the end.
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
    case "re_review_requested":
      return 4;
    case "review_requested":
      return 5;
    case "ready_to_merge":
      return 6;
    case "awaiting_review":
      return 7;
    case "reviewed_waiting":
      return 8;
    case "draft":
      return 9;
    case "mentioned":
      return 10;
    case "merged":
      return 11;
    case "closed":
      return 12;
    default:
      return 13;
  }
}

/**
 * Total ordering for the Focus queue and the Inbox spine: most-pressing first.
 * Bucket (needs_you → waiting_on_others → informational), then state severity,
 * then most-recently-updated first. Pure and stable for a given snapshot.
 */
export function comparePrPriority(a: TrackedPullRequest, b: TrackedPullRequest): number {
  const byBucket = bucketRank(a) - bucketRank(b);
  if (byBucket !== 0) return byBucket;
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

export function safeHttpsUrl(input: string): string | null {
  try {
    const url = new URL(input);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function openExternalHttps(input: string, label: string): Promise<void> {
  const safeUrl = safeHttpsUrl(input);
  if (!safeUrl) {
    toastManager.add({
      type: "error",
      title: "Could not open link",
      description: `Invalid ${label} URL.`,
    });
    return;
  }
  await ensureNativeApi().shell.openExternal(safeUrl);
}
