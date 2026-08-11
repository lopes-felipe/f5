import type { CommandId, NextTurnQueueItem, NextTurnQueueSnapshot } from "@t3tools/contracts";

import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";

export function buildQueueRowDisplay(item: NextTurnQueueItem) {
  const displayed = deriveDisplayedUserMessageState(item.command.message.text);
  const imageCount = item.command.message.attachments.filter(
    (attachment) => attachment.type === "image",
  ).length;
  return {
    ...displayed,
    imageCount,
    label:
      displayed.visibleText.trim().length === 0 &&
      displayed.attachedFilePaths.length === 0 &&
      imageCount > 0
        ? "Image-only turn"
        : displayed.visibleText,
  };
}

export function moveItemInOrder(
  order: ReadonlyArray<CommandId>,
  itemId: CommandId,
  direction: -1 | 1,
): ReadonlyArray<CommandId> {
  const index = order.indexOf(itemId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return order;
  const next = [...order];
  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
  return next;
}

export function describeQueueBlockedState(snapshot: NextTurnQueueSnapshot): string | null {
  const fallback = snapshot.reasonDetail;
  switch (snapshot.reasonCode) {
    case "active_turn":
      return "Waiting for the active turn to finish.";
    case "turn_starting":
      return "Waiting for the previous turn to start.";
    case "dispatch_in_flight":
      return "Sending the next turn.";
    case "delivery_retrying":
      return "Retrying delivery shortly.";
    case "manual_pause":
      return "Queue paused — new turns will wait here.";
    case "turn_failed":
      return fallback ?? "Queue paused after the previous turn failed.";
    case "turn_never_started":
      return "The previous turn never started. Resume to try the next turn.";
    case "turn_interrupted":
      return "Queue paused because the active turn was interrupted.";
    case "thread_archived":
      return "Queue paused because this thread is archived.";
    case "thread_reverted":
      return "Queue paused because this thread was reverted.";
    case "thread_compacting":
      return "Waiting for conversation compaction to finish.";
    case "thread_compacted":
      return "Queue paused after conversation compaction.";
    case "worktree_missing":
      return fallback ?? "Queue paused because the worktree is missing.";
    case "dispatch_rejected":
    case "delivery_rejected":
    case "delivery_ambiguous":
    case "post_processing_stalled":
      return fallback ?? "The queue needs attention.";
    case "turn_post_processing":
      return "Waiting for turn post-processing to finish.";
    case "thread_deleted":
      return "This thread was deleted.";
    case null:
      return fallback;
  }
}

export function deriveQueueAnnouncement(
  previous: NextTurnQueueSnapshot | null,
  current: NextTurnQueueSnapshot,
): string {
  if (previous === null) return `Queue loaded with ${current.items.length} turns.`;
  const delta = current.items.length - previous.items.length;
  if (delta > 0) return `${delta} turn${delta === 1 ? "" : "s"} added to the queue.`;
  if (delta < 0) return `${Math.abs(delta)} queued turn${delta === -1 ? "" : "s"} removed.`;
  if (previous.paused !== current.paused)
    return current.paused ? "Queue paused." : "Queue resumed.";
  if (previous.reasonCode !== current.reasonCode && current.reasonCode) {
    return describeQueueBlockedState(current) ?? "Queue status changed.";
  }
  return "";
}

export function shouldToastEnqueueSuccess(input: {
  readonly collapsed: boolean;
  readonly paused: boolean;
}): boolean {
  return input.collapsed || input.paused;
}
