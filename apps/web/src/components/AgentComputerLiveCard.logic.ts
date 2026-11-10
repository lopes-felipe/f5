import { COMPUTER_ACTION_VERB } from "@t3tools/shared/computerAction";
import type { ComputerActivity, ComputerAppTier, ComputerBackendKind } from "@t3tools/contracts";

export type ComputerStatusTone = "ok" | "pending" | "warning" | "error" | "off";

/** Status dot colors shared by the live strip and the timeline session cards. */
export const COMPUTER_STATUS_TONE_CLASS: Record<ComputerStatusTone, string> = {
  ok: "bg-success",
  pending: "bg-info animate-pulse",
  warning: "bg-warning",
  error: "bg-destructive",
  off: "bg-muted-foreground",
};

export const COMPUTER_TIER_LABEL: Record<ComputerAppTier, string> = {
  view: "View only",
  click: "Click",
  full: "Full control",
  blocked: "Blocked",
};

/** Click-tier grants can separately allow typing, which can run commands. */
export function computerGrantLabel(tier: ComputerAppTier, allowTyping: boolean): string {
  return tier === "click" && allowTyping ? "Click + typing" : COMPUTER_TIER_LABEL[tier];
}

/** Built-in provider backends stop after the current action, so name them in the strip. */
export function computerBackendLabel(backend: ComputerBackendKind | undefined): string | undefined {
  if (backend === "claude-builtin") return "via Claude";
  if (backend === "codex-builtin") return "via Codex";
  return undefined;
}

/** Ongoing and finished wording, so a completed action does not read as still running. */

function humanizeOp(op: string): string {
  return op
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type ActivitySummary = Pick<ComputerActivity, "op" | "status">;

interface ComputerCardState {
  readonly paused?: boolean | undefined;
  readonly held?: boolean | undefined;
  /** The thread holds the Chrome lease: "unknown" when its session doesn't report calls. */
  readonly chrome?: "idle" | "working" | "unknown" | undefined;
}

/**
 * While the thread holds the Chrome lease, its Chrome state outranks any finished native
 * action: the store keeps the last one indefinitely, and it predates the lease.
 */
function showsChrome(activity: ActivitySummary | undefined, state: ComputerCardState): boolean {
  return state.chrome !== undefined && activity?.status !== "started";
}

/** The activity the card describes: none while the Chrome state outranks it. */
export function cardActivity<T extends ActivitySummary>(
  activity: T | undefined,
  chrome: ComputerCardState["chrome"],
): T | undefined {
  return showsChrome(activity, { chrome }) ? undefined : activity;
}

/** Plain-language line for what the agent is doing on the computer. */
export function describeComputerAction(
  activity: ActivitySummary | undefined,
  state: ComputerCardState,
): string {
  if (state.paused) return "You have control";
  if (showsChrome(activity, state))
    return state.chrome === "working"
      ? "Agent is using Chrome"
      : state.chrome === "idle"
        ? "Chrome ready · not in use"
        : "Agent can use Chrome";
  if (!activity) return state.held ? "Agent is controlling this computer" : "Idle";
  const words = humanizeOp(activity.op) || "action";
  const [ongoing, done] = COMPUTER_ACTION_VERB[activity.op] ?? [
    capitalize(words),
    `Finished ${words}`,
  ];
  switch (activity.status) {
    case "started":
      return `${ongoing}…`;
    case "failed":
      return `${ongoing} failed`;
    case "interrupted":
      return `${ongoing} was interrupted`;
    case "completed":
      return done;
  }
}

export interface IdleChromeReservationState {
  /** This thread's lease holder, if any. */
  readonly holder?:
    | { readonly browser?: "idle" | "working" | "unknown" | undefined; readonly state: string }
    | undefined;
  readonly pendingTakeover?: boolean | undefined;
  readonly activityStatus?: ComputerActivity["status"] | undefined;
  readonly paused?: boolean | undefined;
  readonly stopUnconfirmed?: boolean | undefined;
  readonly grantCount: number;
  readonly heldBy?: boolean | undefined;
  readonly outcomeUnknown?: boolean | undefined;
  /** A Chrome call ended moments ago, so the runtime still reads as in use. */
  readonly lingering?: boolean | undefined;
}

/**
 * The thread only holds an idle Chrome lease with nothing to act on or warn about, so the
 * live card can shrink to a one-line strip.
 */
export function isIdleChromeReservation(state: IdleChromeReservationState): boolean {
  return (
    state.holder?.browser === "idle" &&
    state.holder.state === "active" &&
    !state.pendingTakeover &&
    state.activityStatus !== "started" &&
    !state.paused &&
    !state.stopUnconfirmed &&
    state.grantCount === 0 &&
    !state.heldBy &&
    !state.outcomeUnknown &&
    !state.lingering
  );
}

export function computerStatusTone(
  activity: ActivitySummary | undefined,
  state: ComputerCardState,
): ComputerStatusTone {
  if (state.paused) return "warning";
  if (showsChrome(activity, state)) return state.chrome === "idle" ? "ok" : "pending";
  if (activity?.status === "failed") return "error";
  if (activity?.status === "interrupted") return "warning";
  if (activity?.status === "started" || state.held) return "pending";
  if (activity?.status === "completed") return "ok";
  return "off";
}
