import type { ThreadId } from "@t3tools/contracts";
import { ArrowRightIcon, PinIcon, PinOffIcon } from "lucide-react";
import { forwardRef, useCallback } from "react";

import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { getProjectColorClasses } from "../../lib/projectColor";
import { cn } from "../../lib/utils";
import { resolveThreadStatusPillForThread, type ThreadStatus } from "../../threadStatus";
import type { Project, Thread } from "../../types";
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
   * Optional pin state. When provided, a pin button is rendered that only
   * appears on row hover/focus so idle rows stay visually calm. Omitting the
   * props hides the affordance entirely — useful for contexts that don't
   * want pinning (e.g. the pinned section itself, where we surface unpin
   * differently).
   */
  readonly isPinned?: boolean | undefined;
  readonly onTogglePin?: ((threadId: ThreadId) => void) | undefined;
  /**
   * Optional pill rendered to the right of the project/title, used for the
   * Needs Attention section to communicate *why* the row needs attention
   * (e.g. "stale 2d") without replacing the primary status chip.
   */
  readonly reasonTag?: string | undefined;
  /**
   * Drives the left-border accent. Surfacing urgency as a subtle vertical
   * bar lets users scan a dense list of attention items without reading
   * every status label.
   */
  readonly urgencyStatus?: ThreadStatus | undefined;
}

const URGENCY_BORDER_BY_STATUS: Partial<Record<ThreadStatus, string>> = {
  "pending-approval": "before:bg-amber-500/80",
  "awaiting-input": "before:bg-indigo-500/80",
  "plan-ready": "before:bg-warning/80",
  working: "before:bg-sky-500/80",
  connecting: "before:bg-sky-500/60",
};

export const HomeThreadRow = forwardRef<HTMLButtonElement, HomeThreadRowProps>(
  function HomeThreadRow(
    { thread, project, onSelect, rowIndex, isPinned, onTogglePin, reasonTag, urgencyStatus },
    ref,
  ) {
    const pill = resolveThreadStatusPillForThread(thread);
    const title = thread.title.trim() || "Untitled thread";
    const projectName = project?.name ?? "Unknown project";
    // Prefer id for stable colors; fall back to name so "Unknown project" still
    // gets a non-flickering color.
    const projectColor = getProjectColorClasses(project?.id ?? projectName);
    const relativeLabel = formatRelativeTimeLabel(thread.lastInteractionAt);
    const absoluteLabel = formatAbsoluteTimeLabel(thread.lastInteractionAt);
    const urgencyClass = urgencyStatus ? (URGENCY_BORDER_BY_STATUS[urgencyStatus] ?? null) : null;

    const handleTogglePin = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        // Stop the outer row button from being triggered. Without this the
        // click bubbles up and navigates into the thread.
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
          "group/home-row relative flex w-full items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 text-left transition-all",
          "hover:-translate-y-px hover:border-foreground/40 hover:bg-accent/60 hover:shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          // `before:` pseudo element acts as the urgency accent bar. Using
          // the ::before layer keeps the DOM flat and the bar respects the
          // rounded container naturally via inherited border-radius.
          urgencyClass &&
            "before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full",
          urgencyClass,
        )}
      >
        {/* Status chip: icon + label, colored pill. Fixed-width column keeps
            titles aligned across rows, even when the status is unknown. */}
        <span className="flex w-[112px] shrink-0 items-center">
          {pill ? (
            <ThreadStatusPillBadge pill={pill} variant="chip" />
          ) : (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 ring-1 ring-inset ring-muted-foreground/15"
              role="status"
              aria-label="Idle"
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50"
                aria-hidden="true"
              />
              Idle
            </span>
          )}
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-2">
          {/* Project color chip — pre-attentive grouping cue for multi-project
              users. Tooltip names the project for the ambiguous case where two
              projects have similar hashed colors. */}
          <span
            className={cn(
              "inline-block size-2 shrink-0 rounded-full ring-2",
              projectColor.bg,
              projectColor.ring,
            )}
            aria-hidden="true"
            title={projectName}
          />
          <span className="max-w-[26%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
            {projectName}
          </span>
          <span className="shrink-0 text-muted-foreground/30" aria-hidden="true">
            ·
          </span>
          {/* title: 15px medium on md+ for a clearer hierarchy vs. the muted
              project name and the tiny timestamp. `title` attribute restores
              any text that falls off the truncation edge. */}
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground md:text-[14px]"
            title={title}
          >
            {title}
          </span>
          {reasonTag ? (
            <span
              // "Why" is separate from status — uses muted neutral tint so it
              // complements rather than competes with the primary chip.
              className="hidden shrink-0 rounded-full border border-border/50 bg-background/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline"
              title={`Reason: ${reasonTag}`}
            >
              {reasonTag}
            </span>
          ) : null}
        </span>

        <span
          className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
          title={absoluteLabel || undefined}
        >
          {relativeLabel}
        </span>

        {/* Pin affordance: appears on hover/focus so idle rows stay calm.
            When the row is already pinned the star persists always so the
            pinned state remains discoverable at a glance. The inner
            `<span role="button">` avoids nesting a real <button> inside a
            <button> (which is invalid DOM) while still being keyboard-
            interactive via tabIndex + onKeyDown. */}
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
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-opacity",
              "hover:bg-accent hover:text-foreground",
              isPinned
                ? "opacity-100 text-amber-500 dark:text-amber-300"
                : "opacity-0 group-hover/home-row:opacity-100 focus-visible:opacity-100",
            )}
          >
            {isPinned ? (
              <PinOffIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <PinIcon className="size-3.5" aria-hidden="true" />
            )}
          </span>
        ) : null}

        {/* Hover affordance: makes "clickable" obvious and invites quick entry
            without adding layout weight when idle. */}
        <ArrowRightIcon
          className="size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover/home-row:text-foreground/60"
          aria-hidden="true"
        />
      </button>
    );
  },
);
