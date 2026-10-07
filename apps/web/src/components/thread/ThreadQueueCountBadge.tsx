import type { ThreadId } from "@t3tools/contracts";
import { ClockIcon, ListOrderedIcon, PauseIcon } from "lucide-react";

import {
  useNextTurnQueueBadge,
  useNextTurnQueueCount,
  useNextTurnQueueScheduledResumeAt,
} from "../../nextTurnQueueStore";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * Queued-turn count for a thread. Not a live region: it appears in lists
 * (sidebar, Home) where many rows change at once.
 *
 * `compact` (narrow rows such as the sidebar) shows an icon and the count so
 * the thread title keeps its room; the full wording stays in the label.
 */
export function ThreadQueueCountBadge({
  threadId,
  compact = false,
  className,
}: {
  readonly threadId: ThreadId;
  readonly compact?: boolean;
  readonly className?: string | undefined;
}) {
  const count = useNextTurnQueueCount(threadId);
  const scheduledResumeAt = useNextTurnQueueScheduledResumeAt(threadId);
  const badge = useNextTurnQueueBadge(threadId);

  if (badge === "none") return null;

  const label = scheduledResumeAt
    ? `Continues at ${new Date(scheduledResumeAt).toLocaleString()}`
    : badge === "paused"
      ? `${count} queued turns, paused`
      : `${count} queued turns`;
  const Icon = scheduledResumeAt ? ClockIcon : badge === "paused" ? PauseIcon : ListOrderedIcon;
  return (
    <Badge
      variant={badge === "paused" ? "warning" : "secondary"}
      size="sm"
      aria-label={label}
      title={label}
      className={cn("shrink-0 rounded-full px-1.5 tabular-nums", compact && "gap-0.5", className)}
    >
      {compact ? (
        <>
          <Icon aria-hidden="true" className="size-3" />
          {count}
        </>
      ) : (
        <>
          {scheduledResumeAt ? <ClockIcon aria-hidden="true" className="size-3" /> : null}
          {count} queued{badge === "paused" ? " · paused" : ""}
        </>
      )}
    </Badge>
  );
}
