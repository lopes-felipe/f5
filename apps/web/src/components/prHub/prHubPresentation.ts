import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type {
  PrHubAdvisory,
  PrHubAdvisoryRecommendation,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { readAppSettingsSnapshot } from "../../appSettings";
import { defaultSnoozeUntil as defaultSnoozeUntilFor } from "../../lib/snoozePresets";

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
  return defaultSnoozeUntilFor(readAppSettingsSnapshot().snoozePresets);
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

export function isPrSnoozed(pr: TrackedPullRequest, now = Date.now()): boolean {
  return pr.snoozedUntil !== null && Date.parse(pr.snoozedUntil) > now;
}

export function isPrStalled(pr: TrackedPullRequest, hours: number, now = Date.now()): boolean {
  return (
    hours > 0 &&
    pr.state === "open" &&
    !pr.isDraft &&
    pr.roles.includes("author") &&
    pr.waitingSince !== null &&
    now - Date.parse(pr.waitingSince) >= hours * 3_600_000
  );
}

export function waitingLabel(pr: TrackedPullRequest, now = Date.now()): string | null {
  if (
    !pr.waitingSince ||
    !Number.isFinite(Date.parse(pr.waitingSince)) ||
    now - Date.parse(pr.waitingSince) < 3_600_000
  )
    return null;
  return `Waiting since ${formatRelativeTimeLabel(pr.waitingSince, now)}`;
}
