import type {
  PrHubSection,
  PrHubSyncState,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { forgeCapabilitiesFor } from "@t3tools/shared/forgeCapabilities";
import { canViewerReview } from "@t3tools/shared/prHub";

import { prQuickActions } from "../../lib/prQuickActions";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";

export const PR_QUEUE_SECTION_LABELS: Record<PrHubSection, string> = {
  review: "Review requested",
  action: "Your action",
  ready: "Ready to merge",
  waiting: "Waiting on others",
  drafts: "Drafts",
  team: "Team queue",
  other: "Other",
  stale: "Stale",
};

/** What each section holds, for the header tooltip and the empty row. */
export const PR_QUEUE_SECTION_HINTS: Record<PrHubSection, string> = {
  review: "Reviews requested from you, and new commits on pull requests you reviewed.",
  action: "Your pull requests that need a fix.",
  ready: "Your pull requests that can merge now.",
  waiting: "Nothing for you to do until someone else acts.",
  drafts: "Your drafts.",
  team: "Reviews requested from your teams, not from you.",
  other: "Pull requests you are mentioned in or follow.",
  stale: "No activity for a while. Any activity brings a pull request back.",
};

/** Sections that start collapsed; a collapsed section loads nothing. */
export const PR_QUEUE_COLLAPSED_BY_DEFAULT: ReadonlySet<PrHubSection> = new Set([
  "drafts",
  "team",
  "other",
  "stale",
]);

export const PR_QUEUE_COLLAPSE_STORAGE_KEY = "f5.prHub.queue.collapsed";

/** Applies the user's stored open/closed choices over the defaults. */
export function prQueueCollapsed(
  stored: Partial<Record<PrHubSection, boolean>>,
  section: PrHubSection,
): boolean {
  return stored[section] ?? PR_QUEUE_COLLAPSED_BY_DEFAULT.has(section);
}

export type PrRowActionKind =
  | "review"
  | "fix_ci"
  | "resolve_conflicts"
  | "update_branch"
  | "address_feedback"
  | "merge"
  | "mark_ready"
  | "open_thread";

export interface PrRowAction {
  readonly kind: PrRowActionKind;
  readonly label: string;
  /** Set for `open_thread`: the linked thread that is already working on this. */
  readonly threadId?: ThreadId;
}

/** Steps an agent takes in an F5 thread. */
export const PR_AGENT_ACTIONS: ReadonlySet<PrRowActionKind> = new Set([
  "fix_ci",
  "resolve_conflicts",
  "address_feedback",
]);

/**
 * The one next step a row offers. The attention state already orders simultaneous
 * blockers, so it decides. Where an agent would do the work and a linked thread is
 * already running, the step is to open that thread instead of starting another.
 */
export function prRowPrimaryAction(
  pr: TrackedPullRequest,
  context: { readonly runningThreadId?: ThreadId | null | undefined } = {},
): PrRowAction | null {
  if (pr.state !== "open" || pr.ignoredAt !== null || pr.repositoryArchived) return null;
  if (!pr.roles.includes("author")) {
    return canViewerReview(pr) ? { kind: "review", label: "Review" } : null;
  }
  const action = authorAction(pr);
  if (action && PR_AGENT_ACTIONS.has(action.kind) && context.runningThreadId) {
    return { kind: "open_thread", label: "Open thread", threadId: context.runningThreadId };
  }
  return action;
}

function authorAction(pr: TrackedPullRequest): PrRowAction | null {
  switch (pr.attentionState) {
    case "merge_conflict":
      return { kind: "resolve_conflicts", label: "Resolve conflicts" };
    case "ci_failing":
      return { kind: "fix_ci", label: "Fix CI" };
    case "branch_behind": {
      const caps = pr.forgeCapabilities ?? forgeCapabilitiesFor(pr.provider);
      return caps?.actions.includes("update-branch") && caps.updateMethods.length > 0
        ? { kind: "update_branch", label: "Update branch" }
        : null;
    }
    case "changes_requested":
    case "unresolved_comments":
      return { kind: "address_feedback", label: "Address feedback" };
    case "ready_to_merge":
      return { kind: "merge", label: "Merge" };
    case "draft":
      return { kind: "mark_ready", label: "Mark ready" };
    default:
      return null;
  }
}

/** Which steps the page's action bar offers for a pull request. */
export interface PrPageActionAvailability {
  /** Merge now and Merge when ready, for the author. */
  readonly canMerge: boolean;
  readonly canMergeWhenReady: boolean;
  /** The viewer is asked to review: Approve, Comment and Request changes join Review. */
  readonly canReview: boolean;
  readonly canApprove: boolean;
  readonly canComment: boolean;
  readonly canRequestChanges: boolean;
  readonly canSnooze: boolean;
  readonly canIgnore: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly canMarkReady: boolean;
  readonly canConvertToDraft: boolean;
  readonly canReRequest: boolean;
}

export function prPageActionAvailability(pr: TrackedPullRequest): PrPageActionAvailability {
  const caps = pr.forgeCapabilities ?? forgeCapabilitiesFor(pr.provider);
  const open = pr.state === "open" && !pr.repositoryArchived;
  const actionable = open && pr.ignoredAt === null;
  const isAuthor = pr.roles.includes("author");
  const quick = prQuickActions(pr);
  const canReview = actionable && canViewerReview(pr);
  const supports = (action: "approve" | "comment" | "request-changes") =>
    pr.capabilities?.some((item) => item.action === action && item.supported) ?? false;
  return {
    canMerge: actionable && isAuthor && quick.includes("merge"),
    canMergeWhenReady:
      actionable && isAuthor && !pr.isDraft && !!caps?.actions.includes("enable-auto-merge"),
    canReview,
    canApprove: canReview && supports("approve"),
    canComment: open && supports("comment"),
    canRequestChanges: canReview && supports("request-changes"),
    canSnooze: actionable,
    canIgnore: actionable,
    canClose: quick.includes("close"),
    canReopen: quick.includes("reopen"),
    canMarkReady: actionable && quick.includes("ready"),
    canConvertToDraft: actionable && !pr.isDraft && !!caps?.actions.includes("draft"),
    // The forge accepts a re-request only while the author waits on the reviewers it names.
    canReRequest:
      actionable &&
      isAuthor &&
      (pr.attentionState === "awaiting_review" || pr.attentionState === "unresolved_comments") &&
      pr.reviewRequestReviewers.length > 0,
  };
}

export type PrTone = "success" | "warning" | "danger" | "pending" | "muted";

export interface PrRowCell {
  readonly label: string;
  readonly tone: PrTone;
}

export function prRowReview(pr: TrackedPullRequest): PrRowCell {
  switch (pr.reviewDecision) {
    case "approved":
      return { label: "Approved", tone: "success" };
    case "changes_requested":
      return { label: "Changes", tone: "danger" };
    case "review_required":
      return { label: pr.reviewRequestsCount > 0 ? "Pending" : "Required", tone: "pending" };
    case "none":
      return { label: "—", tone: "muted" };
  }
}

export function prRowChecks(pr: TrackedPullRequest): PrRowCell {
  switch (pr.checkRollup) {
    case "success":
      return { label: "Passed", tone: "success" };
    case "failure":
      return { label: "Failed", tone: "danger" };
    case "error":
      return { label: "Error", tone: "danger" };
    case "pending":
      return { label: "Running", tone: "pending" };
    case "none":
      return { label: "—", tone: "muted" };
  }
}

export type PrChecklistActionKind =
  | "request_reviewers"
  | "view_checks"
  | "rerun_checks"
  | "fix_ci"
  | "update_branch"
  | "resolve_conflicts"
  | "view_threads";

export interface PrChecklistAction {
  readonly kind: PrChecklistActionKind;
  readonly label: string;
}

export interface PrChecklistItem {
  readonly id: "review" | "checks" | "branch" | "threads" | "requirements";
  readonly label: string;
  readonly detail: string;
  readonly tone: PrTone;
  /** The steps that move this line forward and that the viewer can take; often none. */
  readonly actions: ReadonlyArray<PrChecklistAction>;
}

/** Whether the forge can re-run the failed jobs of this pull request's checks. */
export function prCanRerunChecks(pr: TrackedPullRequest): boolean {
  const caps = pr.forgeCapabilities ?? forgeCapabilitiesFor(pr.provider);
  return (
    pr.state === "open" &&
    !pr.repositoryArchived &&
    !!caps?.checks.rerun &&
    caps.actions.includes("rerun-failed-checks")
  );
}

/**
 * The merge-readiness summary of the peek and the Overview tab: what is done, what still
 * blocks, and the step that unblocks it.
 */
export function prStatusChecklist(pr: TrackedPullRequest): PrChecklistItem[] {
  const items: PrChecklistItem[] = [];
  const waitingOn = pr.reviewRequestReviewers.slice(0, 3).join(", ");
  const caps = pr.forgeCapabilities ?? forgeCapabilitiesFor(pr.provider);
  const actionable = pr.state === "open" && pr.ignoredAt === null && !pr.repositoryArchived;
  const isAuthor = pr.roles.includes("author");
  const step = (kind: PrChecklistActionKind, label: string, when: boolean): PrChecklistAction[] =>
    actionable && when ? [{ kind, label }] : [];
  const failing = pr.checkRollup === "failure" || pr.checkRollup === "error";
  items.push({
    id: "review",
    label: "Review",
    tone: prRowReview(pr).tone,
    actions: step(
      "request_reviewers",
      "Request reviewers",
      isAuthor && pr.reviewDecision !== "approved" && !!caps?.reviewers.request,
    ),
    detail:
      pr.reviewDecision === "approved"
        ? "Approved"
        : pr.reviewDecision === "changes_requested"
          ? "Changes requested"
          : pr.reviewRequestsCount > 0
            ? `Waiting on ${waitingOn || `${pr.reviewRequestsCount} reviewers`}${
                pr.reviewRequestsCount > 3 ? ` and ${pr.reviewRequestsCount - 3} more` : ""
              }`
            : pr.reviewDecision === "review_required"
              ? "Review required, nobody asked yet"
              : "No review required",
  });
  items.push({
    id: "checks",
    label: "Checks",
    tone: prRowChecks(pr).tone,
    // An agent works on the author's own branch, so only the author is offered the fix.
    actions: [
      ...step("view_checks", "View checks", pr.checkRollup !== "none"),
      ...step("rerun_checks", "Re-run failed jobs", failing && prCanRerunChecks(pr)),
      ...step("fix_ci", "Fix CI with F5", failing && isAuthor),
    ],
    detail:
      pr.checkRollup === "success"
        ? "All checks passed"
        : pr.checkRollup === "failure"
          ? "Some checks failed"
          : pr.checkRollup === "error"
            ? "Some checks could not run"
            : pr.checkRollup === "pending"
              ? "Checks are running"
              : "No checks",
  });
  const behind = pr.mergeStateStatus === "BEHIND";
  items.push({
    id: "branch",
    label: "Branch",
    actions:
      pr.mergeable === "conflicting"
        ? step("resolve_conflicts", "Resolve with F5", isAuthor)
        : step(
            "update_branch",
            "Update branch",
            behind && !!caps?.actions.includes("update-branch") && caps.updateMethods.length > 0,
          ),
    tone:
      pr.mergeable === "conflicting"
        ? "danger"
        : behind
          ? "warning"
          : pr.mergeable === "mergeable"
            ? "success"
            : "muted",
    detail:
      pr.mergeable === "conflicting"
        ? `Conflicts with ${pr.baseRefName || "the base branch"}`
        : behind
          ? `Behind ${pr.baseRefName || "the base branch"}`
          : pr.mergeable === "mergeable"
            ? "No conflicts"
            : "Not checked yet",
  });
  if (pr.unresolvedThreadCount > 0) {
    items.push({
      id: "threads",
      label: "Threads",
      tone: "warning",
      detail: `${pr.unresolvedThreadCount} unresolved`,
      actions: step("view_threads", "View threads", true),
    });
  }
  if (
    pr.mergeRequirements?.verification === "verified" &&
    !pr.mergeRequirements.mandatorySatisfied
  ) {
    items.push({
      id: "requirements",
      label: "Requirements",
      tone: "warning",
      detail: pr.mergeRequirements.explanation,
      actions: [],
    });
  }
  return items;
}

/** The sync pill's short text; unfinished background work is not shown as a problem. */
export function prSyncPillLabel(sync: PrHubSyncState | undefined, now = Date.now()): string {
  if (!sync) return "Loading";
  const synced = sync.lastSyncedAt
    ? `Synced ${formatRelativeTimeLabel(sync.lastSyncedAt, now)}`
    : null;
  switch (sync.state) {
    case "idle":
      return synced ?? "Up to date";
    case "syncing":
      return synced ?? "Syncing";
    case "rate_limited":
      return "Rate limited";
    case "offline":
      return "Offline";
    case "auth_required":
      return "Not connected";
    case "error":
      return "Sync failed";
  }
}

/** One sentence under the pill's heading that says what the state means. */
export function prSyncPillDetail(sync: PrHubSyncState): string {
  const { searches, hydrations } = sync.pending;
  const left = [
    searches > 0 ? `${searches} ${searches === 1 ? "search" : "searches"}` : null,
    hydrations > 0 ? `${hydrations} pull ${hydrations === 1 ? "request" : "requests"}` : null,
  ].filter((part) => part !== null);
  const resume = sync.resumeAt ? ` at ${formatAbsoluteTimeLabel(sync.resumeAt)}` : "";
  switch (sync.state) {
    case "idle":
      return "Everything is up to date.";
    case "syncing":
      return left.length > 0
        ? `Still checking ${left.join(" and ")} in the background. Nothing is wrong.`
        : "Checking for changes.";
    case "rate_limited":
      return `GitHub's rate limit paused the sync. It resumes on its own${resume}.`;
    case "offline":
      return `GitHub is unreachable. The sync retries on its own${resume}.`;
    case "auth_required":
      return sync.message ?? "Connect a GitHub account to load pull requests.";
    case "error":
      return sync.message ?? "The last refresh failed. Saved pull requests are still shown.";
  }
}

export type PrQueueCommand =
  | "next"
  | "previous"
  | "peek"
  | "open"
  | "back"
  | "search"
  | "primary"
  | "merge"
  | "snooze"
  | "ignore"
  | "forge"
  | "refresh"
  | "pageNext"
  | "pagePrevious";

const KEY_COMMANDS: Readonly<Record<string, PrQueueCommand>> = {
  j: "next",
  ArrowDown: "next",
  k: "previous",
  ArrowUp: "previous",
  " ": "peek",
  Enter: "open",
  Escape: "back",
  "/": "search",
  a: "primary",
  m: "merge",
  s: "snooze",
  e: "ignore",
  o: "forge",
  r: "refresh",
  "]": "pageNext",
  "[": "pagePrevious",
};

/** Commands that move through the table; the full page keeps these keys for scrolling. */
const QUEUE_ONLY: ReadonlySet<PrQueueCommand> = new Set([
  "next",
  "previous",
  "peek",
  "open",
  "search",
]);
const PAGE_ONLY: ReadonlySet<PrQueueCommand> = new Set(["pageNext", "pagePrevious"]);
/** Keys matched by the character they produce, whatever modifiers the layout needs for it. */
const LAYOUT_KEYS: ReadonlySet<string> = new Set(["/", "[", "]"]);

/** The fixed single-key shortcuts, with their keys as shown in the shortcuts dialog. */
export const PR_QUEUE_SHORTCUTS: ReadonlyArray<{ readonly keys: string; readonly label: string }> =
  [
    { keys: "J / K", label: "Next / previous pull request" },
    { keys: "Space", label: "Open or close the peek" },
    { keys: "↵", label: "Open the pull request page" },
    { keys: "Esc", label: "Back to the queue" },
    { keys: "/", label: "Search pull requests" },
    { keys: "A", label: "Run the row's next action" },
    { keys: "M", label: "Merge" },
    { keys: "S", label: "Snooze or unsnooze" },
    { keys: "E", label: "Ignore" },
    { keys: "O", label: "Open on the forge" },
    { keys: "R", label: "Refresh" },
    { keys: "[ / ]", label: "Previous / next pull request on the page" },
  ];

/** Maps a key press to a queue command, or null when the key belongs to something else. */
export function prQueueCommand(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  view: "queue" | "page",
): PrQueueCommand | null {
  const command = KEY_COMMANDS[event.key];
  if (!command) return null;
  // "/", "[" and "]" are typed with Shift, Option or AltGr on several layouts (Shift+7 and
  // Option+5 on German, AltGr+5 on AZERTY; AltGr reports Ctrl and Alt). Every other key is
  // a plain press.
  const typed = LAYOUT_KEYS.has(event.key);
  if (event.metaKey || (event.ctrlKey && !(typed && event.altKey))) return null;
  if ((event.altKey || event.shiftKey) && !typed) return null;
  if (view === "page" ? QUEUE_ONLY.has(command) : PAGE_ONLY.has(command)) return null;
  return command;
}

/** The key `delta` rows away from `current`, clamped; the first row when nothing is selected. */
export function movePrQueueCursor<Key extends string>(
  keys: readonly Key[],
  current: Key | null,
  delta: number,
): Key | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  if (index < 0) return keys[0]!;
  return keys[Math.min(Math.max(index + delta, 0), keys.length - 1)]!;
}
