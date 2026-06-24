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

export function defaultSnoozeUntil(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
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
