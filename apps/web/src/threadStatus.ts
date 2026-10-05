import {
  CheckIcon,
  CircleAlertIcon,
  FileTextIcon,
  type LucideIcon,
  LoaderIcon,
  MessageCircleIcon,
  PlayIcon,
} from "lucide-react";

import type { Thread } from "./types";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "./session-logic";

export type ThreadStatus =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "plan-ready"
  | "completed"
  | "none";

export interface ThreadStatusPill {
  label: Exclude<ThreadStatusLabel, null>;
  colorClass: string;
  dotClass: string;
  /** Soft tinted background used by the "pill" variant of the badge. */
  chipClass: string;
  /** Glyph that communicates the status at a glance without relying on color. */
  icon: LucideIcon;
  pulse: boolean;
}

type ThreadStatusLabel =
  | "Working"
  | "Connecting"
  | "Completed"
  | "Pending Approval"
  | "Awaiting Input"
  | "Plan Ready"
  | null;

export type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session"
>;

export interface ResolveThreadStatusInput {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}

/**
 * Semantic status colours (F3). Plan-ready shares `warning` with pending
 * approval and is told apart by its icon; awaiting input uses `attention`.
 */
const THREAD_STATUS_PILL_BY_STATUS: Record<Exclude<ThreadStatus, "none">, ThreadStatusPill> = {
  "pending-approval": {
    label: "Pending Approval",
    colorClass: "text-warning-foreground",
    dotClass: "bg-warning",
    chipClass: "bg-warning/10 text-warning-foreground ring-1 ring-warning/20",
    icon: CircleAlertIcon,
    pulse: false,
  },
  "awaiting-input": {
    label: "Awaiting Input",
    colorClass: "text-attention-foreground",
    dotClass: "bg-attention",
    chipClass: "bg-attention/10 text-attention-foreground ring-1 ring-attention/20",
    icon: MessageCircleIcon,
    pulse: false,
  },
  working: {
    label: "Working",
    colorClass: "text-info-foreground",
    dotClass: "bg-info",
    chipClass: "bg-info/10 text-info-foreground ring-1 ring-info/20",
    icon: PlayIcon,
    pulse: true,
  },
  connecting: {
    label: "Connecting",
    colorClass: "text-info-foreground",
    dotClass: "bg-info",
    chipClass: "bg-info/10 text-info-foreground ring-1 ring-info/20",
    icon: LoaderIcon,
    pulse: true,
  },
  "plan-ready": {
    label: "Plan Ready",
    colorClass: "text-warning-foreground",
    dotClass: "bg-warning",
    chipClass: "bg-warning/10 text-warning-foreground ring-1 ring-warning/20",
    icon: FileTextIcon,
    pulse: false,
  },
  completed: {
    label: "Completed",
    colorClass: "text-success-foreground",
    dotClass: "bg-success",
    chipClass: "bg-success/10 text-success-foreground ring-1 ring-success/20",
    icon: CheckIcon,
    pulse: false,
  },
};

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function resolveThreadStatus(input: ResolveThreadStatusInput): ThreadStatus {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return "pending-approval";
  }

  if (hasPendingUserInput) {
    return "awaiting-input";
  }

  if (thread.session?.status === "running") {
    return "working";
  }

  if (thread.session?.status === "connecting") {
    return "connecting";
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    );
  if (hasPlanReadyPrompt) {
    return "plan-ready";
  }

  if (hasUnseenCompletion(thread)) {
    return "completed";
  }

  return "none";
}

export function resolveThreadStatusForThread(thread: Thread): ThreadStatus {
  return resolveThreadStatus({
    thread,
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
  });
}

export function resolveThreadStatusPillForThread(thread: Thread): ThreadStatusPill | null {
  const status = resolveThreadStatusForThread(thread);
  return status === "none" ? null : THREAD_STATUS_PILL_BY_STATUS[status];
}

export function isVisibleThreadStatus(
  status: ThreadStatus,
): status is Exclude<ThreadStatus, "none"> {
  return status !== "none";
}

export function threadStatusLabel(status: ThreadStatus): ThreadStatusLabel {
  return status === "none" ? null : THREAD_STATUS_PILL_BY_STATUS[status].label;
}

export function pillForStatus(status: ThreadStatus): ThreadStatusPill | null {
  return status === "none" ? null : THREAD_STATUS_PILL_BY_STATUS[status];
}

export function resolveThreadStatusPill(input: ResolveThreadStatusInput): ThreadStatusPill | null {
  return pillForStatus(resolveThreadStatus(input));
}

export function threadStatusIcon(status: ThreadStatus) {
  return status === "none" ? null : THREAD_STATUS_PILL_BY_STATUS[status].icon;
}
