import type { ThreadId } from "@t3tools/contracts";

import { useNextTurnQueueBadge, useNextTurnQueueCount } from "../../nextTurnQueueStore";
import { cn } from "../../lib/utils";

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

  return (
    <span
      role="status"
      aria-label={badge === "paused" ? `${count} queued turns, paused` : `${count} queued turns`}
      title={badge === "paused" ? `${count} queued turns · paused` : `${count} queued turns`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px font-mono text-[10px] tabular-nums",
        badge === "paused"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border/60 bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {count} queued{badge === "paused" ? " · paused" : ""}
    </span>
  );
}
