import type { CommandId, NextTurnQueueSnapshot, WorktreeSetupSnapshot } from "@t3tools/contracts";

import type { TaskItem } from "~/types";
import { buildQueueRowDisplay, isFoldedUsageLimitItem } from "../NextTurnQueuePanel.logic";
import { isWorktreeSetupCollapsible } from "../WorktreeSetupCard";

/** Longest queued-turn preview a chip shows before truncating. */
export const QUEUE_CHIP_PREVIEW_MAX_LENGTH = 32;

export function truncateChipText(text: string, maxLength: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1).trimEnd()}…` : line;
}

export interface TaskChipSummary {
  readonly done: number;
  readonly total: number;
}

export function summarizeTaskChip(tasks: ReadonlyArray<Pick<TaskItem, "status">>): TaskChipSummary {
  return {
    done: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
  };
}

export interface QueueChipSummary {
  readonly count: number;
  readonly preview: string | null;
  readonly paused: boolean;
  readonly warning: boolean;
}

/**
 * The queue as a status chip, or null when it must stay inline: nothing is
 * queued, or the queue needs the user (a delivery to recover, quarantined
 * turns, an error, a pause the user did not ask for, a workspace switch in
 * progress or a failed sync).
 */
export function summarizeQueueChip(input: {
  readonly snapshot: NextTurnQueueSnapshot | null;
  /** Turns sent to the queue that the server has not confirmed yet. */
  readonly optimistic: ReadonlyArray<{ readonly text: string }>;
  readonly syncError: string | null;
  readonly foldedItemId: CommandId | null;
}): QueueChipSummary | null {
  const { snapshot } = input;
  if (!snapshot || input.syncError) return null;
  if (
    (snapshot.unresolvedDelivery ?? null) !== null ||
    snapshot.reasonCode === "delivery_rejected" ||
    snapshot.reasonCode === "delivery_ambiguous" ||
    snapshot.quarantinedCount > 0 ||
    snapshot.blockedKind === "error" ||
    (snapshot.paused && snapshot.reasonCode !== "manual_pause")
  ) {
    return null;
  }
  const transition = snapshot.workspaceTransition;
  if (transition && !["completed", "cancelled"].includes(transition.phase)) return null;
  const items = snapshot.items.filter((item) => !isFoldedUsageLimitItem(item, input.foldedItemId));
  const count = items.length + input.optimistic.length;
  if (count === 0) return null;
  const first = items[0];
  const label = (
    first ? buildQueueRowDisplay(first).label : (input.optimistic[0]?.text ?? "")
  ).trim();
  return {
    count,
    preview: label ? truncateChipText(label, QUEUE_CHIP_PREVIEW_MAX_LENGTH) : null,
    paused: snapshot.paused,
    warning:
      snapshot.paused || (snapshot.blockedKind !== null && snapshot.blockedKind !== "waiting"),
  };
}

/** A finished setup with only warnings needs no action, so it can fold into a chip. */
export function isWorktreeSetupChip(snapshot: WorktreeSetupSnapshot): boolean {
  return isWorktreeSetupCollapsible(snapshot);
}

export function worktreeSetupWarningCount(snapshot: WorktreeSetupSnapshot): number {
  return snapshot.stages.filter((stage) => stage.status === "warning").length;
}
