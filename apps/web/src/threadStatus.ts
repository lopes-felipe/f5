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

const THREAD_STATUS_PILL_BY_STATUS: Record<Exclude<ThreadStatus, "none">, ThreadStatusPill> = {
  "pending-approval": {
    label: "Pending Approval",
    colorClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
    chipClass:
      "bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-300/20",
    icon: CircleAlertIcon,
    pulse: false,
  },
  "awaiting-input": {
    label: "Awaiting Input",
    colorClass: "text-indigo-600 dark:text-indigo-300/90",
    dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
    chipClass:
      "bg-indigo-500/10 text-indigo-700 ring-1 ring-indigo-500/20 dark:bg-indigo-400/10 dark:text-indigo-200 dark:ring-indigo-300/20",
    icon: MessageCircleIcon,
    pulse: false,
  },
  working: {
    label: "Working",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    chipClass:
      "bg-sky-500/10 text-sky-700 ring-1 ring-sky-500/20 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-300/20",
    icon: PlayIcon,
    pulse: true,
  },
  connecting: {
    label: "Connecting",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    chipClass:
      "bg-sky-500/10 text-sky-700 ring-1 ring-sky-500/20 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-300/20",
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
    colorClass: "text-emerald-600 dark:text-emerald-300/90",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
    chipClass:
      "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/20 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-300/20",
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

export function resolveThreadStatusPill(input: ResolveThreadStatusInput): ThreadStatusPill | null {
  const status = resolveThreadStatus(input);
  return status === "none" ? null : THREAD_STATUS_PILL_BY_STATUS[status];
}
