import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
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
  workflowRouteForType,
  workflowTypeLabel,
} from "./sidebarLists";
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
 * A collapsed workflow's second line: the step it is on, its state, model and time. Clicking
 * opens that step's thread, or the workflow before the step has one.
 */
function WorkflowCurrentStepLine(props: {
  step: WorkflowCurrentStep;
  thread: ThreadSummary | undefined;
  completedAt: string;
  ownerRowId: string | null;
  isActive: boolean;
  onOpen: () => void;
}) {
  const { step, thread } = props;
  const { icon: Icon, word, className } = CURRENT_STEP_ICON[step.state];
  const model = thread ? (thread.modelSelection?.model ?? thread.model) : step.modelSlot?.model;
  const at = step.state === "completed" ? props.completedAt : (thread?.lastInteractionAt ?? null);
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
        {step.state === "completed" ? "Completed" : step.label}
        {step.state === "completed" ? null : (
          <span className="text-faint-foreground">{` · ${word}`}</span>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {model && step.state !== "completed" ? (
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

  return (
    <SidebarMenuSubItem className="group/workflow-row relative w-full">
      <SidebarMenuSubButton
        render={
          <div
            role="button"
            tabIndex={0}
            {...treeRowProps}
            // In the tree the row is a group of its threads; Right and Left use its chevron.
            aria-expanded={isTreeRow && workflowThreads.length > 0 ? !workflowCollapsed : undefined}
          />
        }
        size="md"
        isActive={isWorkflowActive}
        className={cn(
          resolveThreadRowClassName({ isActive: isWorkflowActive, isSelected: false }),
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
        <WorkflowPhaseStrip phases={props.phases ?? []} />
        <span className="relative flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Archive ${workflow.title}`}
                  className={cn(
                    "-mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    "opacity-0 group-hover/workflow-row:opacity-100 group-focus-within/workflow-row:opacity-100 pointer-coarse:opacity-100",
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
      {workflowCollapsed && currentStep ? (
        <WorkflowCurrentStepLine
          step={currentStep}
          thread={currentStepThread}
          completedAt={workflow.updatedAt}
          ownerRowId={isTreeRow ? workflowRowId : null}
          isActive={currentStep.threadId !== null && currentStep.threadId === routeThreadId}
          onOpen={() => {
            if (currentStep.threadId !== null) actions.openThread(currentStep.threadId);
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
        className={resolveThreadRowClassName({ isActive, isSelected: false })}
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
