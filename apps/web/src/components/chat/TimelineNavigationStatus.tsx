import { LoaderIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { TimelineNavigationStatus } from "./useTimelineNavigation";

const MESSAGES: Record<Exclude<TimelineNavigationStatus, "idle">, string> = {
  loading: "Loading that part of the conversation…",
  failed: "Could not load that part of the conversation.",
  unavailable: "That message is no longer available.",
};

/** Floats over the top of the timeline while a jump loads, fails or misses. */
export function TimelineNavigationStatusBanner({
  status,
  onRetry,
  onDismiss,
}: {
  status: TimelineNavigationStatus;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3"
      data-thread-find-ignore
    >
      {status === "idle" ? null : (
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover py-1 ps-3 pe-1 text-sm text-popover-foreground shadow-lg/5"
          data-slot="timeline-navigation-status"
          data-status={status}
        >
          {status === "loading" ? (
            <LoaderIcon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : null}
          <span>{MESSAGES[status]}</span>
          {status === "failed" ? (
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={status === "loading" ? "Cancel" : "Dismiss"}
            onClick={onDismiss}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
