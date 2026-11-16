import type { UpstreamOverview, UpstreamPortQueueView } from "@t3tools/contracts";
import { ListOrderedIcon, PauseIcon } from "lucide-react";

import { Button } from "../ui/button";

/** Whether the queue has anything the user would want to see now. */
export function portQueueIsLive(queue: UpstreamOverview["portQueue"]): boolean {
  return queue.running + queue.queuedThreads + queue.needsAttention > 0 || queue.paused || queue.hold !== null;
}

/** The tab to open: Needs you when that is the only thing left, otherwise Active. */
export function portQueueLandingView(queue: UpstreamOverview["portQueue"]): UpstreamPortQueueView {
  return queue.running + queue.queuedThreads === 0 && queue.needsAttention > 0 ? "needs-you" : "active";
}

/** Header chip for the port queue; opens the Queue view. Hidden when there is nothing live. */
export function UpstreamPortQueueChip(props: {
  readonly overview: UpstreamOverview;
  readonly onOpen: (view: UpstreamPortQueueView) => void;
}) {
  const queue = props.overview.portQueue;
  if (!portQueueIsLive(queue)) return null;
  const label = queue.paused
    ? "Paused"
    : queue.hold
      ? queue.hold.retryAt
        ? `Waiting until ${new Date(queue.hold.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "Waiting"
      : queue.running + queue.queuedThreads > 0
        ? `${queue.running}/${queue.concurrency} running · ${queue.queuedThreads.toLocaleString()} queued`
        : "Port queue";
  const attention =
    queue.needsAttention > 0 ? `, ${queue.needsAttention.toLocaleString()} need${queue.needsAttention === 1 ? "s" : ""} attention` : "";
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={`Port queue: ${label}${attention}`}
      title={queue.hold?.message ?? queue.pausedReason ?? undefined}
      onClick={() => props.onOpen(portQueueLandingView(queue))}
    >
      {queue.paused ? <PauseIcon /> : <ListOrderedIcon />}
      {label}
      {queue.needsAttention > 0 && (
        <span className="ms-0.5 inline-flex items-center gap-1 text-warning-foreground">
          <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
          {queue.needsAttention.toLocaleString()}
        </span>
      )}
    </Button>
  );
}
