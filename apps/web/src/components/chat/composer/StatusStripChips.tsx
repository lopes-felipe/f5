import type { ThreadTaskTracking, WorktreeSetupSnapshot } from "@t3tools/contracts";
import { GitBranchIcon, ListOrderedIcon, ListTodoIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { TaskItem } from "~/types";
import type { ThreadNotice } from "../ThreadNoticeStack";
import { StatusChip } from "./ComposerStatusStrip";
import {
  summarizeTaskChip,
  worktreeSetupWarningCount,
  type QueueChipSummary,
} from "./ComposerStatusStrip.logic";
import { describeTaskSync, ThreadTasksPanel } from "./ThreadTasksPanel";

export function TasksStatusChip(props: {
  readonly tasks: ReadonlyArray<TaskItem>;
  readonly tracking?: Pick<ThreadTaskTracking, "syncState" | "syncDetail"> | null | undefined;
  readonly summary: string;
}) {
  const { done, total } = summarizeTaskChip(props.tasks);
  const syncNotice = describeTaskSync(props.tracking);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <StatusChip
      chipId="tasks"
      icon={ListTodoIcon}
      tone={syncNotice ? "warning" : "neutral"}
      ariaLabel={`Tasks: ${props.summary}${syncNotice ? `. ${syncNotice}` : ""}`}
      popupLabel="Task list"
      label={
        <>
          Tasks
          {total > 0 ? (
            <>
              <span
                aria-hidden
                className="h-1 w-8 overflow-hidden rounded-full bg-muted-foreground/25"
              >
                <span className="block h-full bg-success" style={{ width: `${percent}%` }} />
              </span>
              <span className="tabular-nums">
                {done}/{total}
              </span>
            </>
          ) : null}
        </>
      }
    >
      <div className="p-3">
        <ThreadTasksPanel
          variant="popover"
          tasks={props.tasks}
          tracking={props.tracking}
          summary={props.summary}
        />
      </div>
    </StatusChip>
  );
}

export function NoticeStatusChip(props: { readonly notice: ThreadNotice }) {
  const { chip } = props.notice;
  if (!chip) return null;
  return (
    <StatusChip
      chipId={props.notice.id}
      icon={chip.icon}
      tone={chip.tone}
      ariaLabel={chip.ariaLabel}
      popupLabel={chip.ariaLabel}
      label={chip.label}
    >
      <div className="[&>[data-slot=alert]]:rounded-none [&>[data-slot=alert]]:border-0">
        {props.notice.content}
      </div>
    </StatusChip>
  );
}

export function WorktreeStatusChip(props: {
  readonly snapshot: WorktreeSetupSnapshot;
  /** The setup card, opened expanded. */
  readonly children: ReactNode;
}) {
  const warnings = worktreeSetupWarningCount(props.snapshot);
  const warningLabel = warnings === 1 ? "1 warning" : `${warnings} warnings`;
  return (
    <StatusChip
      chipId="worktree"
      icon={GitBranchIcon}
      tone={warnings > 0 ? "warning" : "neutral"}
      ariaLabel={`Worktree ready, ${props.snapshot.request.branch}${warnings > 0 ? `, ${warningLabel}` : ""}`}
      popupLabel="Worktree setup"
      label={warnings > 0 ? `Worktree · ${warningLabel}` : "Worktree ready"}
    >
      {props.children}
    </StatusChip>
  );
}

export function QueueStatusChip(props: {
  readonly summary: QueueChipSummary;
  /** The queue panel the popover opens. */
  readonly children: ReactNode;
}) {
  const { count, preview, paused, warning } = props.summary;
  const countLabel = `${count} queued`;
  return (
    <StatusChip
      chipId="queue"
      icon={ListOrderedIcon}
      tone={warning ? "warning" : "neutral"}
      ariaLabel={[countLabel, paused ? "paused" : null, preview ? `next: ${preview}` : null]
        .filter(Boolean)
        .join(", ")}
      popupLabel="Queued turns"
      // Land on the panel, as "Focus queued turns" does when it is inline.
      initialFocus={() => document.getElementById("next-turn-queue-panel") ?? true}
      label={
        <>
          <span className="tabular-nums">{countLabel}</span>
          {paused ? (
            <span className="rounded bg-warning/20 px-1 text-2xs leading-4">PAUSED</span>
          ) : null}
          {preview ? (
            <span className="hidden max-w-[16rem] truncate text-muted-foreground @[44rem]/status-strip:inline">
              · “{preview}”
            </span>
          ) : null}
        </>
      }
    >
      {props.children}
    </StatusChip>
  );
}
