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

/** Plain-language line for what the agent is doing on the computer. */
export function describeComputerAction(
  activity: ActivitySummary | undefined,
  state: { readonly paused?: boolean | undefined; readonly held?: boolean | undefined },
): string {
  if (state.paused) return "You have control";
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

export function computerStatusTone(
  activity: ActivitySummary | undefined,
  state: { readonly paused?: boolean | undefined; readonly held?: boolean | undefined },
): ComputerStatusTone {
  if (state.paused) return "warning";
  if (activity?.status === "failed") return "error";
  if (activity?.status === "interrupted") return "warning";
  if (activity?.status === "started" || state.held) return "pending";
  if (activity?.status === "completed") return "ok";
  return "off";
}
