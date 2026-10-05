import type { ThreadId } from "@t3tools/contracts";

import { useNextTurnQueueBadge, useNextTurnQueueCount } from "../../nextTurnQueueStore";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * Queued-turn count for a thread. Not a live region: it appears in lists
 * (sidebar, Home) where many rows change at once.
 */
export function ThreadQueueCountBadge({
  threadId,
  className,
}: {
  readonly threadId: ThreadId;
  readonly className?: string | undefined;
}) {
  const count = useNextTurnQueueCount(threadId);
  const badge = useNextTurnQueueBadge(threadId);

  if (badge === "none") return null;

  const label = badge === "paused" ? `${count} queued turns, paused` : `${count} queued turns`;
  return (
    <Badge
      variant={badge === "paused" ? "warning" : "secondary"}
      size="sm"
      aria-label={label}
      title={label}
      className={cn("shrink-0 rounded-full px-1.5 tabular-nums", className)}
    >
      {count} queued{badge === "paused" ? " · paused" : ""}
    </Badge>
  );
}
