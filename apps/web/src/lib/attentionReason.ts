import type { ThreadStatus } from "../threadStatus";

/**
 * Derive a short, secondary label that explains *why* an "attention" row
 * needs the user — beyond the status chip itself. The primary signal is age:
 * a plan that's been sitting for days conveys urgency differently than one
 * that was just minted.
 *
 * Kept terse (≤ ~12 chars) so it fits inline beside a long title without
 * wrapping or overwhelming the row.
 */
export function resolveAttentionReasonTag(
  status: ThreadStatus,
  lastInteractionAt: string,
  now: Date = new Date(),
): string | null {
  const timestamp = new Date(lastInteractionAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = now.getTime() - timestamp;
  const oneDayMs = 24 * 60 * 60 * 1000;

  const days = Math.floor(diffMs / oneDayMs);

  if (status === "pending-approval") {
    if (days >= 1) return `waiting ${days}d`;
    return "awaiting approval";
  }

  if (status === "awaiting-input") {
    if (days >= 1) return `waiting ${days}d`;
    return "needs reply";
  }

  if (status === "plan-ready") {
    if (days >= 2) return `stale ${days}d`;
    if (days >= 1) return "stale 1d";
    return null;
  }

  return null;
}
