import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface ThreadNotice {
  readonly id: string;
  readonly content: ReactNode;
}

export const THREAD_NOTICE_STACK_VISIBLE_COUNT = 2;

/**
 * Thread-level notices (errors, unconfirmed sends, provider health) shown
 * above the composer. At most two are visible; the rest fold behind a
 * "N more notices" toggle so they never push the composer off screen.
 */
export function ThreadNoticeStack(props: { notices: ReadonlyArray<ThreadNotice> }) {
  const [expanded, setExpanded] = useState(false);
  if (props.notices.length === 0) return null;
  const hiddenCount = Math.max(0, props.notices.length - THREAD_NOTICE_STACK_VISIBLE_COUNT);
  const visible = expanded
    ? props.notices
    : props.notices.slice(0, THREAD_NOTICE_STACK_VISIBLE_COUNT);

  return (
    <div data-slot="thread-notice-stack" className="divide-y divide-border">
      {visible.map((notice) => (
        <div
          key={notice.id}
          className="[&>[data-slot=alert]]:rounded-none [&>[data-slot=alert]]:border-0"
        >
          {notice.content}
        </div>
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex h-7 w-full items-center justify-center gap-1 text-2xs text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {expanded
            ? "Show fewer notices"
            : `${hiddenCount} more ${hiddenCount === 1 ? "notice" : "notices"}`}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform duration-(--duration-fast)",
              expanded && "rotate-180",
            )}
          />
        </button>
      ) : null}
    </div>
  );
}
