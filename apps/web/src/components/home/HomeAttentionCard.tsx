import type { ThreadId } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { resolveThreadStatusPillForThread, type ThreadStatus } from "../../threadStatus";
import type { Project, Thread } from "../../types";
import { ProjectIcon } from "../ProjectIcon";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import { Button } from "../ui/button";

/** The one action a "Needs you" card offers; navigation only, no approval logic. */
export function attentionCardActionLabel(status: ThreadStatus | undefined): string {
  switch (status) {
    case "plan-ready":
      return "Review plan";
    case "awaiting-input":
      return "Answer";
    case "pending-approval":
      return "Review approval";
    default:
      return "Open";
  }
}

const CARD_ACCENT_BY_STATUS: Partial<Record<ThreadStatus, string>> = {
  "pending-approval": "border-warning/40",
  "awaiting-input": "border-attention/40",
  "plan-ready": "border-warning/30",
};

/**
 * Dashboard card for a thread that is waiting on the user. The primary
 * action deep-links into the thread and hands focus to its composer, where
 * the plan, question or approval controls live.
 */
export function HomeAttentionCard(props: {
  readonly thread: Thread;
  readonly project: Project | undefined;
  readonly status: ThreadStatus | undefined;
  readonly reasonTag?: string | undefined;
  readonly rowIndex?: number | undefined;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { thread, project, status } = props;
  const pill = resolveThreadStatusPillForThread(thread);
  const title = thread.title.trim() || "Untitled thread";
  const projectName = project?.name ?? "Unknown project";
  const actionLabel = attentionCardActionLabel(status);

  return (
    <article
      data-slot="home-attention-card"
      data-status={status}
      aria-label={title}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-xs/5",
        status ? CARD_ACCENT_BY_STATUS[status] : null,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        {project ? (
          <ProjectIcon
            projectId={project.id}
            name={project.name}
            icon={project.icon}
            className="size-3.5 shrink-0"
          />
        ) : null}
        <span className="min-w-0 truncate font-mono">{projectName}</span>
        <span
          className="ms-auto shrink-0 tabular-nums"
          title={formatAbsoluteTimeLabel(thread.lastInteractionAt) || undefined}
        >
          {formatRelativeTimeLabel(thread.lastInteractionAt)}
        </span>
      </div>
      <p className="line-clamp-2 text-sm font-medium text-foreground" title={title}>
        {title}
      </p>
      <div className="mt-auto flex items-center gap-2">
        {pill ? <ThreadStatusPillBadge pill={pill} variant="chip" live={false} /> : null}
        {props.reasonTag ? (
          <span className="truncate font-mono text-2xs text-muted-foreground">
            {props.reasonTag}
          </span>
        ) : null}
        <Button
          size="sm"
          variant={status === "pending-approval" || status === "plan-ready" ? "default" : "outline"}
          className="ms-auto shrink-0"
          data-home-row-index={props.rowIndex}
          onClick={() => props.onOpen(thread.id)}
        >
          {actionLabel}
          <ArrowRightIcon />
        </Button>
      </div>
    </article>
  );
}
