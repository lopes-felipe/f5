import type { ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon, CircleIcon, LoaderIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { formatUsd } from "../../lib/formatUsd";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import {
  WORKFLOW_TYPE_ICON,
  WORKFLOW_TYPE_ICON_CLASS,
  type WorkflowTypeValue,
} from "../../lib/workflowType";
import { formatElapsed } from "../../session-logic";
import { useStore } from "../../store";
import type { Thread } from "../../types";
import { AppTitlebar } from "../AppTitlebar";
import { ProjectIcon } from "../ProjectIcon";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { WorkflowBoard } from "./WorkflowBoard";
import { WorkflowTimelinePhaseList } from "./WorkflowTimelinePhaseList";
import type { WorkflowOverallState, WorkflowTimelinePhase } from "./workflowTimelineTypes";

export type WorkflowPageView = "board" | "list";

const OVERALL_STATE_TONE: Record<
  WorkflowOverallState,
  { readonly icon: LucideIcon; readonly className: string }
> = {
  active: {
    icon: LoaderIcon,
    className: "border-info/40 text-info-foreground [&_svg]:motion-safe:animate-status-pulse",
  },
  error: { icon: CircleAlertIcon, className: "border-destructive/40 text-destructive-foreground" },
  completed: { icon: CheckIcon, className: "border-success/40 text-success-foreground" },
  pending: { icon: CircleIcon, className: "border-border text-muted-foreground" },
};

function WorkflowStatusChip(props: { state: WorkflowOverallState; label: string }) {
  const { icon: Icon, className } = OVERALL_STATE_TONE[props.state];
  return (
    <span
      data-slot="workflow-status"
      data-state={props.state}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-2xs font-medium",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {props.label}
    </span>
  );
}

/**
 * "Ran 12m" once the run stopped (finished or failed); "Started 5m ago"
 * while it is still going or has not started.
 */
export function workflowElapsedLabel(input: {
  readonly state: WorkflowOverallState;
  readonly createdAt: string;
  readonly updatedAt: string;
}): string | null {
  if (input.state === "completed" || input.state === "error") {
    const elapsed = formatElapsed(input.createdAt, input.updatedAt);
    return elapsed ? `Ran ${elapsed}` : null;
  }
  const started = formatRelativeTimeLabel(input.createdAt);
  return started ? `Started ${started}` : null;
}

function useWorkflowProject(projectId: ProjectId) {
  return useStore((store) => store.projects.find((project) => project.id === projectId) ?? null);
}

/** Title bar for a workflow route that has nothing to show yet. */
export function WorkflowPageNotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AppTitlebar
        breadcrumb={[{ label: "Workflow" }]}
        onClose={() => void navigate({ to: "/" })}
        closeLabel="Close workflow"
      />
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>Workflow not found.</EmptyTitle>
          <EmptyDescription>It may have been deleted, or it has not synced yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/**
 * Shared page for planning, document, code-review and investigation runs: a
 * title bar (project > type, status, close), a title block with run meta and
 * actions, the steps (a board of phase columns at `lg+`, a list below), then
 * the run's artifacts.
 */
export function WorkflowPageLayout(props: {
  readonly projectId: ProjectId;
  readonly workflowType: WorkflowTypeValue;
  /** Type crumb text, e.g. "Feature", "Code Review" or "Document · RFC". */
  readonly typeLabel: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly overallState: WorkflowOverallState;
  readonly totalCostUsd?: number | null | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly actions?: ReactNode;
  readonly phases: readonly WorkflowTimelinePhase[];
  readonly threadById: ReadonlyMap<Thread["id"], Thread>;
  /** Overrides the breakpoint switch (board at `lg+`, list below). */
  readonly view?: WorkflowPageView | undefined;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const project = useWorkflowProject(props.projectId);
  const isWide = useMediaQuery("lg");
  const view = props.view ?? (isWide ? "board" : "list");
  const TypeIcon = WORKFLOW_TYPE_ICON[props.workflowType];
  const elapsed = workflowElapsedLabel({
    state: props.overallState,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
  const cost =
    props.totalCostUsd !== null && props.totalCostUsd !== undefined && props.totalCostUsd > 0
      ? formatUsd(props.totalCostUsd)
      : null;

  return (
    <div
      data-slot="workflow-page"
      data-view={view}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <AppTitlebar
        breadcrumb={[
          {
            key: "project",
            label: project?.name ?? "Project",
            icon: project ? (
              <ProjectIcon
                projectId={project.id}
                name={project.name}
                icon={project.icon}
                className="size-3.5 shrink-0"
              />
            ) : undefined,
          },
          {
            key: "type",
            label: props.typeLabel,
            // The page title below is the heading; the crumb stays plain text.
            render: (
              <span className="flex min-w-0 items-center gap-1.5 px-1 text-ui text-foreground">
                <TypeIcon
                  aria-hidden="true"
                  className={cn("size-3.5 shrink-0", WORKFLOW_TYPE_ICON_CLASS[props.workflowType])}
                />
                <span className="truncate">{props.typeLabel}</span>
              </span>
            ),
          },
        ]}
        status={<WorkflowStatusChip state={props.overallState} label={props.statusLabel} />}
        onClose={() => void navigate({ to: "/" })}
        closeLabel="Close workflow"
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-4 pb-10">
          <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                {props.title}
              </h1>
              <p
                data-slot="workflow-meta"
                className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-muted-foreground"
              >
                <span>{props.statusLabel}</span>
                {cost ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{cost}</span>
                  </>
                ) : null}
                {elapsed ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span title={formatAbsoluteTimeLabel(props.createdAt) || undefined}>
                      {elapsed}
                    </span>
                  </>
                ) : null}
                {project ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-2xs">{project.name}</span>
                  </>
                ) : null}
              </p>
            </div>
            {props.actions ? (
              <div className="flex flex-wrap items-center gap-2">{props.actions}</div>
            ) : null}
          </header>
          {view === "board" ? (
            <>
              <WorkflowBoard phases={props.phases} threadById={props.threadById} />
              <main className="flex min-w-0 flex-col gap-6">{props.children}</main>
            </>
          ) : (
            <div className="grid min-w-0 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
              <aside className="min-w-0 rounded-xl border border-border bg-card p-2">
                <WorkflowTimelinePhaseList phases={props.phases} threadById={props.threadById} />
              </aside>
              <main className="flex min-w-0 flex-col gap-6">{props.children}</main>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
