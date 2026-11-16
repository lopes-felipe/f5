import { Link } from "@tanstack/react-router";
import type { ScheduledOrigin } from "@t3tools/contracts";
export function ScheduledOriginBadge({ origin }: { origin?: ScheduledOrigin | null | undefined }) {
  return origin ? (
    <Link
      className="shrink-0 rounded border px-1 text-xs text-muted-foreground hover:text-foreground"
      to="/scheduled"
      search={{ taskId: origin.taskId }}
      onClick={(e) => e.stopPropagation()}
    >
      Scheduled
    </Link>
  ) : null;
}
