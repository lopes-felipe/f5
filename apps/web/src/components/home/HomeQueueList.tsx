import type { OrchestrationThreadPeek, ProjectId, ThreadId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { PauseIcon, PinIcon, WorkflowIcon } from "lucide-react";
import { type Ref, useEffect, useRef } from "react";

import type { HomeQueue } from "../../lib/homeQueue";
import { useNowMinute } from "../../lib/nowTicker";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { selectThreadById, type ThreadSummary } from "../../threadSelectors";
import { pillForStatus } from "../../threadStatus";
import type { Project } from "../../types";
import { useLiveThreadActivityAt } from "../thread/ThreadActivityTime";
import { SectionLabel } from "../ui/section-label";
import {
  HOME_KIND_LABELS,
  homeRowSummary,
  type HomeItem,
  type HomeThreadItem,
  type HomeWorkflowItem,
  type HomeWorkflowRow,
} from "./homeItems";

/** DOM id of a queue row, for `aria-activedescendant` and scrolling it into view. */
export function homeQueueRowDomId(itemId: string): string {
  return `home-queue-row-${itemId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

// The listbox holds focus for its rows, so the keyboard's focus ring goes on the selected
// row, not around the whole list.
const ROW_CLASS_NAME =
  "group/home-row relative flex w-full cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-accent/60 aria-selected:bg-accent aria-selected:before:pointer-events-none aria-selected:before:absolute aria-selected:before:inset-y-2 aria-selected:before:left-0 aria-selected:before:w-0.5 aria-selected:before:rounded-full aria-selected:before:bg-primary group-focus-visible/home-queue:aria-selected:ring-2 group-focus-visible/home-queue:aria-selected:ring-ring group-focus-visible/home-queue:aria-selected:ring-inset";

function projectLabel(project: Project | undefined): string {
  if (!project) return "Unknown project";
  return isScratchProject(project) ? "No project" : project.name;
}

function RowShell(props: {
  readonly itemId: string;
  readonly selected: boolean;
  readonly title: string;
  readonly glyph: React.ReactNode;
  readonly secondary: React.ReactNode;
  readonly trailing: React.ReactNode;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <div
      id={homeQueueRowDomId(props.itemId)}
      role="option"
      aria-selected={props.selected}
      aria-label={props.title}
      data-home-item={props.itemId}
      className={ROW_CLASS_NAME}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
    >
      <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
        {props.glyph}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui font-medium text-foreground" title={props.title}>
          {props.title}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
          {props.secondary}
        </span>
      </span>
      <span className="flex shrink-0 items-center self-center">{props.trailing}</span>
    </div>
  );
}

function ThreadRow(props: {
  readonly item: HomeThreadItem;
  readonly project: Project | undefined;
  readonly peek: OrchestrationThreadPeek | undefined;
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  "use memo";
  const { item } = props;
  const summary = item.thread;
  // The full thread carries what the row describes: the pending request, the error, the turn.
  const thread = useStore((state) => selectThreadById(state, summary.id));
  const now = useNowMinute();
  const activityAt = useLiveThreadActivityAt(summary.id, summary.lastInteractionAt);
  const pill = pillForStatus(summary.status);
  const title = summary.title.trim() || "Untitled thread";
  const detail = thread ? homeRowSummary({ kind: item.kind, thread, peek: props.peek, now }) : null;
  const tasks = thread?.tasks ?? [];
  const tasksDone = tasks.filter((task) => task.status === "completed").length;
  const Icon = pill?.icon;

  return (
    <RowShell
      itemId={item.id}
      selected={props.selected}
      title={title}
      onSelect={() => props.onSelect(item.id)}
      onOpen={() => props.onOpenThread(summary.id)}
      glyph={
        Icon && pill ? (
          <Icon
            aria-hidden="true"
            className={cn("size-3.5", pill.colorClass, pill.pulse && "animate-status-pulse")}
          />
        ) : item.kind === "queue-paused" ? (
          <PauseIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
        ) : (
          <PinIcon aria-hidden="true" className="size-3.5 text-faint-foreground" />
        )
      }
      secondary={
        <>
          <span className="shrink-0 font-mono">{projectLabel(props.project)}</span>
          {detail ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate" title={detail}>
                {detail}
              </span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span
            className="shrink-0 tabular-nums"
            title={formatAbsoluteTimeLabel(activityAt) || undefined}
          >
            {formatRelativeTimeLabel(activityAt, now)}
          </span>
        </>
      }
      trailing={
        item.kind === "running" ? (
          tasks.length > 0 ? (
            <span
              className="font-mono text-2xs text-muted-foreground tabular-nums"
              title={`${tasksDone} of ${tasks.length} tasks done`}
            >
              {tasksDone}/{tasks.length}
            </span>
          ) : null
        ) : item.kind === "pinned" ? null : (
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-2xs font-medium",
              pill?.chipClass ?? "bg-warning/10 text-warning-foreground ring-1 ring-warning/20",
            )}
          >
            {HOME_KIND_LABELS[item.kind]}
          </span>
        )
      }
    />
  );
}

function WorkflowRow(props: {
  readonly item: HomeWorkflowItem;
  readonly project: Project | undefined;
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  readonly onOpenWorkflow: (workflow: HomeWorkflowRow) => void;
}) {
  "use memo";
  const { item } = props;
  const workflow = item.workflow;
  const now = useNowMinute();
  const step = workflow.meta.currentStep?.label;
  return (
    <RowShell
      itemId={item.id}
      selected={props.selected}
      title={workflow.title}
      onSelect={() => props.onSelect(item.id)}
      onOpen={() => props.onOpenWorkflow(workflow)}
      glyph={
        <WorkflowIcon
          aria-hidden="true"
          className="size-3.5 animate-status-pulse text-info-foreground"
        />
      }
      secondary={
        <>
          <span className="shrink-0 font-mono">{projectLabel(props.project)}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">
            {step ? `${workflow.typeLabel} · ${step}` : workflow.typeLabel}
          </span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">
            {formatRelativeTimeLabel(workflow.activityAt, now)}
          </span>
        </>
      }
      trailing={
        <span className="inline-flex h-5 items-center rounded-full bg-info/10 px-1.5 text-2xs font-medium text-info-foreground ring-1 ring-info/20">
          Workflow
        </span>
      }
    />
  );
}

/**
 * The triage queue: one listbox across every group, with the selection as its active
 * descendant. It holds focus itself, so the keys Home handles reach it without a row
 * taking a tab stop each.
 */
export function HomeQueueList(props: {
  readonly queue: HomeQueue<ThreadSummary, HomeWorkflowRow>;
  readonly selectedId: string | null;
  readonly projectsById: ReadonlyMap<ProjectId, Project>;
  readonly peeks: ReadonlyMap<ThreadId, OrchestrationThreadPeek>;
  readonly listRef: Ref<HTMLDivElement>;
  readonly onSelect: (itemId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenWorkflow: (workflow: HomeWorkflowRow) => void;
}) {
  const { queue, selectedId } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keyboard moves can select a row outside the scrolled area.
  useEffect(() => {
    if (!selectedId) return;
    containerRef.current
      ?.querySelector(`#${CSS.escape(homeQueueRowDomId(selectedId))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const renderRow = (item: HomeItem) =>
    item.type === "thread" ? (
      <ThreadRow
        key={item.id}
        item={item}
        project={props.projectsById.get(item.thread.projectId)}
        peek={props.peeks.get(item.thread.id)}
        selected={item.id === selectedId}
        onSelect={props.onSelect}
        onOpenThread={props.onOpenThread}
      />
    ) : (
      <WorkflowRow
        key={item.id}
        item={item}
        project={props.projectsById.get(item.workflow.projectId)}
        selected={item.id === selectedId}
        onSelect={props.onSelect}
        onOpenWorkflow={props.onOpenWorkflow}
      />
    );

  return (
    <div
      ref={(element) => {
        containerRef.current = element;
        if (typeof props.listRef === "function") props.listRef(element);
        else if (props.listRef) props.listRef.current = element;
      }}
      role="listbox"
      aria-label="Queue"
      aria-activedescendant={selectedId ? homeQueueRowDomId(selectedId) : undefined}
      tabIndex={0}
      data-slot="home-queue"
      className="group/home-queue flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg outline-none"
    >
      {queue.groups.map((group) => {
        const headingId = `home-queue-group-${group.id}`;
        return (
          <div key={group.id} role="group" aria-labelledby={headingId} className="flex flex-col">
            <SectionLabel as="h2" id={headingId} count={group.items.length} className="px-2.5">
              {group.label}
            </SectionLabel>
            {group.items.map(renderRow)}
          </div>
        );
      })}
    </div>
  );
}
