import type { ThreadId } from "@t3tools/contracts";

import { useNowMinute } from "../../lib/nowTicker";
import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { useThreadActivityAt } from "../../threadSelectors";

/**
 * The live last-activity time of a thread. List rows render from summaries
 * whose `lastInteractionAt` is only an ordering key, so this leaf reads the
 * live value itself and is the only part of a row that re-renders when a
 * streaming thread's activity time moves. `fallback` covers unsaved drafts.
 */
export function useLiveThreadActivityAt(threadId: ThreadId, fallback: string): string {
  return useThreadActivityAt(threadId) ?? fallback;
}

export function ThreadRelativeActivityTime(props: { threadId: ThreadId; fallback: string }) {
  const activityAt = useLiveThreadActivityAt(props.threadId, props.fallback);
  // Re-render as the minute turns so "5m ago" keeps counting while idle.
  useNowMinute();
  return <>{formatRelativeTimeLabel(activityAt)}</>;
}
