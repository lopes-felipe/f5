import type { ThreadId } from "@t3tools/contracts";
import { ArrowRightIcon, PinIcon, PinOffIcon } from "lucide-react";
import { forwardRef, useCallback } from "react";

import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { resolveThreadStatusPillForThread, type ThreadStatus } from "../../threadStatus";
import type { Project, Thread } from "../../types";
import { ProjectIcon } from "../ProjectIcon";
import { ThreadQueueCountBadge } from "../thread/ThreadQueueCountBadge";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";

interface HomeThreadRowProps {
  readonly thread: Thread;
  readonly project: Project | undefined;
  readonly onSelect: (threadId: ThreadId) => void;
  /**
   * Flat index in the Home keyboard navigation ring. Used by the parent to
   * locate and focus a specific row via `data-home-row-index` when the user
   * presses `j`/`k`.
   */
  readonly rowIndex?: number | undefined;
  /**
   * Optional pin state. When provided, a pin control appears on row hover or
   * focus (always on coarse pointers, and always while pinned).
   */
  readonly isPinned?: boolean | undefined;
  readonly onTogglePin?: ((threadId: ThreadId) => void) | undefined;
  /** Why the row needs attention, e.g. "stale 2d", next to the status chip. */
  readonly reasonTag?: string | undefined;
  /** Drives the thin urgency bar on the row's leading edge. */
  readonly urgencyStatus?: ThreadStatus | undefined;
}

const URGENCY_BORDER_BY_STATUS: Partial<Record<ThreadStatus, string>> = {
  "pending-approval": "before:bg-warning",
  "awaiting-input": "before:bg-attention",
  "plan-ready": "before:bg-warning/80",
  working: "before:bg-info",
  connecting: "before:bg-info/60",
};

export const HomeThreadRow = forwardRef<HTMLButtonElement, HomeThreadRowProps>(
  function HomeThreadRow(
    { thread, project, onSelect, rowIndex, isPinned, onTogglePin, reasonTag, urgencyStatus },
    ref,
  ) {
    const pill = resolveThreadStatusPillForThread(thread);
    const title = thread.title.trim() || "Untitled thread";
    const projectName = project?.name ?? "Unknown project";
    const relativeLabel = formatRelativeTimeLabel(thread.lastInteractionAt);
    const absoluteLabel = formatAbsoluteTimeLabel(thread.lastInteractionAt);
    const urgencyClass = urgencyStatus ? (URGENCY_BORDER_BY_STATUS[urgencyStatus] ?? null) : null;

    const handleTogglePin = useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        // Keep the click from reaching the row button, which would navigate.
        event.stopPropagation();
        event.preventDefault();
        onTogglePin?.(thread.id);
      },
      [onTogglePin, thread.id],
    );

    return (
      <button
        ref={ref}
        type="button"
        onClick={() => onSelect(thread.id)}
        data-home-row-index={rowIndex}
        className={cn(
          "group/home-row relative flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none transition-colors duration-(--duration-fast)",
          "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
          urgencyClass &&
            "before:pointer-events-none before:absolute before:inset-y-2.5 before:left-0 before:w-0.5 before:rounded-full",
          urgencyClass,
        )}
      >
        {project ? (
          <ProjectIcon
            projectId={project.id}
            name={project.name}
            icon={project.icon}
            className="size-4 shrink-0"
          />
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0 rounded-sm bg-muted" />
        )}
        <span className="max-w-[24%] shrink-0 truncate font-mono text-2xs text-muted-foreground">
          {projectName}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>
          {title}
        </span>
        <ThreadQueueCountBadge threadId={thread.id} />
        {pill ? (
          <ThreadStatusPillBadge pill={pill} variant="chip" live={false} className="shrink-0" />
        ) : null}
        {reasonTag ? (
          <span
            className="hidden shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground sm:inline"
            title={`Reason: ${reasonTag}`}
          >
            {reasonTag}
          </span>
        ) : null}
        <span
          className="shrink-0 text-2xs tabular-nums text-muted-foreground"
          title={absoluteLabel || undefined}
        >
          {relativeLabel}
        </span>

        {/* A span with role=button: a real <button> cannot nest inside the row button. */}
        {onTogglePin ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={isPinned ? "Unpin thread" : "Pin thread"}
            aria-pressed={isPinned}
            onClick={handleTogglePin}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.stopPropagation();
                event.preventDefault();
                onTogglePin(thread.id);
              }
            }}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-(--duration-fast)",
              "hover:bg-accent hover:text-foreground",
              isPinned
                ? "text-warning-foreground opacity-100"
                : "opacity-0 group-hover/home-row:opacity-100 group-focus-visible/home-row:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            {isPinned ? (
              <PinOffIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <PinIcon className="size-3.5" aria-hidden="true" />
            )}
          </span>
        ) : null}

        <ArrowRightIcon
          className="size-3.5 shrink-0 text-faint-foreground opacity-0 transition-opacity duration-(--duration-fast) group-hover/home-row:opacity-100 group-focus-visible/home-row:opacity-100"
          aria-hidden="true"
        />
      </button>
    );
  },
);
