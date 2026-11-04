import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  GitPullRequestIcon,
  LoaderIcon,
} from "lucide-react";

import { formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import {
  WORKFLOW_TYPE_ICON,
  WORKFLOW_TYPE_ICON_CLASS,
  workflowDisplayType,
} from "../../lib/workflowType";
import type { ThreadStatusPill } from "../../threadStatus";
import type { ThreadSummary } from "../../threadSelectors";
import type { ThreadListItem } from "../../types";
import { ModelChip } from "../chat/ModelChip";
import {
  resolveThreadRowClassName,
  resolveWorkflowThreadListExpanded,
  SIDEBAR_TREE_LEVEL_CLASS_NAME,
  SIDEBAR_TREE_ROW_HEIGHT_CLASS_NAME,
} from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type {
  WorkflowCurrentStep,
  WorkflowOverallState,
  WorkflowPhaseSummary,
} from "../workflow/workflowTimelineTypes";
import { workflowThreadDisplayTitle } from "../workflow/workflowUtils";
import {
  type PrStatusIndicator,
  type SidebarWorkflowEntry,
  type SidebarWorkflowId,
  type SidebarWorkflowType,
  type TerminalStatusIndicator,
  isWorkflowRouteActive,
  workflowPrLabel,
  workflowRouteForType,
  workflowTypeLabel,
} from "./sidebarLists";
import { useSidebarPeekTrigger } from "./SidebarPeekCard";
import { SIDEBAR_ROW_REVEAL_CLASS_NAME, SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarThreadActions } from "./useSidebarThreadActions";
import { SidebarTreeParentContext, useSidebarTreeRowProps } from "./sidebarTreeRow";

export interface SidebarThreadRowIndicators {
  threadStatus: ThreadStatusPill | null;
  prStatus: PrStatusIndicator | null;
  terminalStatus: TerminalStatusIndicator | null;
  isUnread: boolean;
}

const PHASE_DOT_CLASS: Record<WorkflowPhaseSummary["state"], string> = {
  completed: "bg-success",
  active: "bg-info ring-2 ring-info/30 animate-status-pulse",
  error: "bg-destructive",
  pending: "bg-border",
};

const PHASE_STATE_LABEL: Record<WorkflowPhaseSummary["state"], string> = {
  completed: "done",
  active: "running",
  error: "needs attention",
  pending: "pending",
};

/** "3 of 5 phases complete, Implement running". */
export function describeWorkflowPhases(phases: readonly WorkflowPhaseSummary[]): string {
  const done = phases.filter((phase) => phase.state === "completed").length;
  const current = phases.find((phase) => phase.state === "active" || phase.state === "error");
  return [
    `${done} of ${phases.length} phases complete`,
    ...(current ? [`${current.label} ${PHASE_STATE_LABEL[current.state]}`] : []),
  ].join(", ");
}

/** One dot per phase (done, running, failed, pending); the tooltip names each phase. */
function WorkflowPhaseStrip({ phases }: { phases: readonly WorkflowPhaseSummary[] }) {
  if (phases.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 items-center gap-0.5 px-0.5"
            data-testid="workflow-phase-strip"
          />
        }
      >
        {phases.map((phase, index) => (
          <span
            // Phases keep their order and may share a label across workflow types.
            key={`${index}:${phase.label}`}
            aria-hidden="true"
            data-phase-state={phase.state}
            className={cn("size-1.5 shrink-0 rounded-full", PHASE_DOT_CLASS[phase.state])}
          />
        ))}
        <span className="sr-only">{describeWorkflowPhases(phases)}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="flex-col items-start gap-0.5">
        {phases.map((phase, index) => (
          <span key={`${index}:${phase.label}`} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", PHASE_DOT_CLASS[phase.state])}
            />
            {phase.label}
            <span className="text-muted-foreground">{PHASE_STATE_LABEL[phase.state]}</span>
          </span>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

const CURRENT_STEP_ICON: Record<
  WorkflowCurrentStep["state"],
  { icon: typeof CheckIcon; word: string; className: string }
> = {
  running: { icon: LoaderIcon, word: "running", className: "text-info-foreground" },
  "needs-attention": {
    icon: CircleAlertIcon,
    word: "needs attention",
    className: "text-destructive-foreground",
  },
  waiting: { icon: CircleDashedIcon, word: "waiting", className: "text-faint-foreground" },
  completed: { icon: CheckIcon, word: "completed", className: "text-success-foreground" },
};

/**
 * A finished workflow's one-line status, in place of the phase strip: the last thread's PR
 * (`#462` in its state's color) or a check. Clicking opens the last thread. The time sits in
 * the archive button's slot, like a thread row's, so the right edges line up.
 */
function WorkflowFinishedStatus(props: {
  pr: PrStatusIndicator | null;
  canOpen: boolean;
  onOpenLastThread: () => void;
}) {
  const { pr } = props;
  return (
    <span className="flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="workflow-finished-status"
              aria-label={pr ? `Open last thread, ${pr.tooltip}` : "Open last thread"}
              disabled={!props.canOpen}
              className={cn(
                "-mx-0.5 inline-flex h-5 items-center gap-0.5 rounded-md px-0.5 text-2xs tabular-nums outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
                pr ? pr.colorClass : "text-success-foreground",
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onOpenLastThread();
              }}
            >
              {pr ? (
                <>
                  <GitPullRequestIcon aria-hidden="true" className="size-3" />
                  {`#${pr.number}`}
                </>
              ) : (
                <CheckIcon aria-hidden="true" className="size-3.5" />
              )}
            </button>
          }
        />
        <TooltipPopup side="top">{pr ? workflowPrLabel(pr) : "Completed"}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * A collapsed, unfinished workflow's second line: the step it is on, its state, model and
 * time. Clicking opens the step's target thread, or the workflow before it has any thread.
 */
function WorkflowCurrentStepLine(props: {
  step: WorkflowCurrentStep;
  thread: ThreadSummary | undefined;
  ownerRowId: string | null;
  isActive: boolean;
  onOpen: () => void;
}) {
  const { step, thread } = props;
  const { icon: Icon, word, className } = CURRENT_STEP_ICON[step.state];
  const model = thread ? (thread.modelSelection?.model ?? thread.model) : step.modelSlot?.model;
  const at = thread?.lastInteractionAt ?? null;
  return (
    <button
      type="button"
      data-testid="workflow-current-step"
      {...(props.ownerRowId ? { "data-sidebar-action-for": props.ownerRowId } : {})}
      data-thread-selection-safe
      className={cn(
        "-mt-0.5 mb-px flex h-5 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 pl-8 text-left text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.isActive && "text-foreground",
      )}
      onClick={props.onOpen}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0",
          className,
          step.state === "running" && "animate-status-pulse",
        )}
      />
      <span className="min-w-0 truncate">
        {step.label}
        <span className="text-faint-foreground">{` · ${word}`}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {model ? (
          <ModelChip
            model={model}
            provider={thread ? undefined : step.modelSlot?.provider}
            sessionProviderName={thread?.sessionProvider}
            iconOnly
          />
        ) : null}
        {at ? <span className="tabular-nums">{formatRelativeTimeLabel(at)}</span> : null}
      </span>
    </button>
  );
}

function WorkflowTypeGlyph({
  type,
  workflow,
}: {
  type: SidebarWorkflowType;
  workflow: SidebarWorkflowEntry["workflow"];
}) {
  const displayType = workflowDisplayType(type, workflow);
  const Icon = WORKFLOW_TYPE_ICON[displayType];
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", WORKFLOW_TYPE_ICON_CLASS[displayType])}
    />
  );
}

export function SidebarWorkflowItem(props: {
  entry: SidebarWorkflowEntry;
  workflowThreads: readonly ThreadSummary[];
  /** Role label per thread from the workflow's phases. */
  threadLabels: ReadonlyMap<ThreadId, string>;
  overallState: WorkflowOverallState;
  /** Non-skipped phases for the phase strip. */
  phases?: readonly WorkflowPhaseSummary[] | undefined;
  /** The step named under the row while it is collapsed. */
  currentStep?: WorkflowCurrentStep | null | undefined;
  pathname: string;
  routeThreadId: ThreadId | null;
  expandByDefault: boolean;
  overrideExpanded: boolean | undefined;
  onToggleCollapsed: (workflowId: string, fallbackExpanded: boolean) => void;
  onArchive: (workflowId: SidebarWorkflowId, title: string, type: SidebarWorkflowType) => void;
  indicatorsForThread: (thread: ThreadListItem) => SidebarThreadRowIndicators;
  actions: SidebarThreadActions;
}) {
  "use memo";
  const { entry, workflowThreads, pathname, routeThreadId, actions } = props;
  const { workflow, type } = entry;
  const navigate = useNavigate();
  const workflowRoute = workflowRouteForType(type);
  const isWorkflowActive = isWorkflowRouteActive(pathname, workflow.id, type);
  const orderedWorkflowThreadIds = workflowThreads.map((thread) => thread.id);
  const defaultWorkflowExpanded = resolveWorkflowThreadListExpanded({
    expandByDefault: props.expandByDefault,
    activeThreadId: routeThreadId,
    workflowThreadIds: orderedWorkflowThreadIds,
    overallState: props.overallState,
  });
  const workflowExpanded = resolveWorkflowThreadListExpanded({
    overrideExpanded: props.overrideExpanded,
    expandByDefault: props.expandByDefault,
    activeThreadId: routeThreadId,
    workflowThreadIds: orderedWorkflowThreadIds,
    overallState: props.overallState,
  });
  const workflowCollapsed = !workflowExpanded;
  const typeLabel = workflowTypeLabel(type, workflow);
  const workflowRowId = `workflow:${workflow.id}`;
  const treeRowProps = useSidebarTreeRowProps(workflowRowId);
  const isTreeRow = "data-sidebar-row" in treeRowProps;
  const openWorkflow = () => {
    void navigate({
      to: workflowRoute,
      params: { workflowId: workflow.id },
    });
  };
  const currentStep = props.currentStep ?? null;
  const currentStepThread =
    currentStep?.threadId != null
      ? workflowThreads.find((thread) => thread.id === currentStep.threadId)
      : undefined;
  const targetThreadId = currentStep?.targetThreadId ?? null;
  const targetThread =
    targetThreadId !== null
      ? workflowThreads.find((thread) => thread.id === targetThreadId)
      : undefined;
  // A finished workflow is one line: its last thread's PR (or a check) replaces the strip.
  const finished = currentStep?.state === "completed";
  const targetPr =
    finished && targetThread ? props.indicatorsForThread(targetThread).prStatus : null;
  const peekTrigger = useSidebarPeekTrigger(
    {
      kind: "workflow",
      title: workflow.title,
      typeLabel,
      projectId: workflow.projectId,
      phases: props.phases ?? [],
      currentStep,
      threads: workflowThreads,
      onOpenWorkflow: openWorkflow,
      onOpenThread: actions.openThread,
    },
    { prefetchThreadId: targetThreadId },
  );

  return (
    <SidebarMenuSubItem className="group/workflow-row relative w-full">
      <SidebarMenuSubButton
        render={peekTrigger(
          <div
            role="button"
            tabIndex={0}
            {...treeRowProps}
            // In the tree the row is a group of its threads; Right and Left use its chevron.
            aria-expanded={isTreeRow && workflowThreads.length > 0 ? !workflowCollapsed : undefined}
          />,
        )}
        size="md"
        isActive={isWorkflowActive}
        className={cn(
          resolveThreadRowClassName({ isActive: isWorkflowActive, isSelected: false }),
          SIDEBAR_TREE_ROW_HEIGHT_CLASS_NAME,
          !isWorkflowActive && "text-foreground",
        )}
        onClick={openWorkflow}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openWorkflow();
        }}
      >
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <span
            className={cn(
              "inline-flex",
              workflowThreads.length > 0 &&
                "group-hover/workflow-row:opacity-0 group-focus-within/workflow-row:opacity-0",
            )}
          >
            <WorkflowTypeGlyph type={type} workflow={workflow} />
          </span>
          <button
            type="button"
            aria-label={
              workflowCollapsed ? `Expand ${workflow.title}` : `Collapse ${workflow.title}`
            }
            aria-expanded={!workflowCollapsed}
            data-sidebar-tree-toggle
            className={cn(
              "absolute inset-0 inline-flex items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
              workflowThreads.length > 0
                ? "opacity-0 group-hover/workflow-row:opacity-100 group-focus-within/workflow-row:opacity-100 pointer-coarse:opacity-100"
                : "pointer-events-none opacity-0",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onToggleCollapsed(workflow.id, defaultWorkflowExpanded);
            }}
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-(--duration-fast)",
                !workflowCollapsed && "rotate-90",
              )}
            />
          </button>
        </span>
        <span className="min-w-0 flex-1 truncate" title={`${typeLabel}: ${workflow.title}`}>
          {workflow.title}
          <span className="sr-only">{`, ${typeLabel} workflow`}</span>
        </span>
        {finished ? (
          <WorkflowFinishedStatus
            pr={targetPr}
            canOpen={targetThreadId !== null}
            onOpenLastThread={() => {
              if (targetThreadId !== null) actions.openThread(targetThreadId);
            }}
          />
        ) : (
          <WorkflowPhaseStrip phases={props.phases ?? []} />
        )}
        <span className="relative flex shrink-0 items-center justify-end">
          {finished ? (
            // The time gives way to the archive button on hover, as on thread rows.
            <span className="text-2xs font-normal text-muted-foreground tabular-nums group-hover/workflow-row:invisible group-focus-within/workflow-row:invisible pointer-coarse:invisible">
              {formatRelativeTimeLabel(workflow.updatedAt)}
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Archive ${workflow.title}`}
                  className={cn(
                    "-mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    "opacity-0 group-hover/workflow-row:opacity-100 group-focus-within/workflow-row:opacity-100 pointer-coarse:opacity-100",
                    finished && "absolute top-1/2 right-0 -translate-y-1/2",
                  )}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onArchive(workflow.id, workflow.title, type);
                  }}
                >
                  <ArchiveIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Archive workflow</TooltipPopup>
          </Tooltip>
        </span>
      </SidebarMenuSubButton>
      {workflowCollapsed && currentStep && !finished ? (
        <WorkflowCurrentStepLine
          step={currentStep}
          thread={currentStepThread}
          ownerRowId={isTreeRow ? workflowRowId : null}
          isActive={targetThreadId !== null && targetThreadId === routeThreadId}
          onOpen={() => {
            if (targetThreadId !== null) actions.openThread(targetThreadId);
            else openWorkflow();
          }}
        />
      ) : null}
      {!workflowCollapsed && workflowThreads.length > 0 ? (
        // Second tree level: the guide line sits under the workflow's type icon.
        <SidebarTreeParentContext.Provider value={isTreeRow ? workflowRowId : null}>
          <SidebarMenuSub className={cn(SIDEBAR_TREE_LEVEL_CLASS_NAME, "mt-px")}>
            {workflowThreads.map((thread) => (
              <SidebarThreadRow
                key={thread.id}
                thread={thread}
                section="workflow"
                isActive={routeThreadId === thread.id}
                orderedIds={orderedWorkflowThreadIds}
                displayTitle={
                  props.threadLabels.get(thread.id) ??
                  (entry.type === "planning"
                    ? workflowThreadDisplayTitle(entry.workflow, thread.title)
                    : thread.title)
                }
                workflowTitle={workflow.title}
                trailingMeta={
                  <ModelChip
                    model={thread.modelSelection?.model ?? thread.model}
                    sessionProviderName={thread.sessionProvider}
                    iconOnly
                  />
                }
                isRenaming={false}
                actions={actions}
                {...props.indicatorsForThread(thread)}
              />
            ))}
          </SidebarMenuSub>
        </SidebarTreeParentContext.Provider>
      ) : null}
    </SidebarMenuSubItem>
  );
}

export function SidebarArchivedWorkflowRow(props: {
  type: SidebarWorkflowType;
  workflow: SidebarWorkflowEntry["workflow"];
  pathname: string;
  onUnarchive: (workflowId: SidebarWorkflowId, type: SidebarWorkflowType) => void;
}) {
  const { type, workflow, pathname } = props;
  const navigate = useNavigate();
  const workflowRoute = workflowRouteForType(type);
  const isActive = isWorkflowRouteActive(pathname, workflow.id, type);
  const typeLabel = workflowTypeLabel(type, workflow);
  const treeRowProps = useSidebarTreeRowProps(`workflow:archived:${workflow.id}`);
  const openWorkflow = () => {
    void navigate({
      to: workflowRoute,
      params: { workflowId: workflow.id },
    });
  };

  return (
    <SidebarMenuSubItem className="group/thread-row w-full">
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} {...treeRowProps} />}
        size="md"
        isActive={isActive}
        className={cn(
          resolveThreadRowClassName({ isActive, isSelected: false }),
          SIDEBAR_TREE_ROW_HEIGHT_CLASS_NAME,
          !isActive && "opacity-60 hover:opacity-100 focus-within:opacity-100",
        )}
        data-row-done
        onClick={openWorkflow}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          openWorkflow();
        }}
      >
        <WorkflowTypeGlyph type={type} workflow={workflow} />
        <span className="min-w-0 flex-1 truncate" title={`${typeLabel}: ${workflow.title}`}>
          {workflow.title}
          <span className="sr-only">{`, ${typeLabel} workflow`}</span>
        </span>
        <span className="relative flex shrink-0 items-center justify-end">
          <span className="text-2xs tabular-nums text-muted-foreground group-hover/thread-row:invisible group-focus-within/thread-row:invisible pointer-coarse:invisible">
            {formatRelativeTimeLabel(workflow.updatedAt)}
          </span>
          <span className="absolute inset-y-0 right-0 flex items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Unarchive ${workflow.title}`}
                    className={cn(
                      "-mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                      SIDEBAR_ROW_REVEAL_CLASS_NAME,
                    )}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onUnarchive(workflow.id, type);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <ArchiveRestoreIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">Unarchive</TooltipPopup>
            </Tooltip>
          </span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
