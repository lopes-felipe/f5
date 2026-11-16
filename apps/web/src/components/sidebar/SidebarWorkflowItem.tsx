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
import type { HTMLAttributes, ReactNode } from "react";

import { deleteWorkflow } from "../../archiveActions";
import { readNativeApi } from "../../nativeApi";
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
import { ThreadRelativeActivityTime } from "../thread/ThreadActivityTime";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import {
  resolveThreadRowClassName,
  resolveWorkflowThreadListExpanded,
  SIDEBAR_TREE_LEVEL_CLASS_NAME,
  SIDEBAR_DONE_ROW_CLASS_NAME,
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
  isWorkflowRouteActive,
  workflowPrLabel,
  workflowRouteForType,
  workflowTypeLabel,
} from "./sidebarLists";
import { useSidebarPeekTrigger } from "./SidebarPeekCard";
import { SIDEBAR_ROW_REVEAL_CLASS_NAME, SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarThreadActions } from "./useSidebarThreadActions";
import { SidebarTreeParentContext, useSidebarTreeRowProps } from "./sidebarTreeRow";
import {
  type WorkflowSidebarGroup,
  type WorkflowSidebarRow,
  groupWorkflowThreadsByPhase,
  newestActivityThread,
} from "./sidebarWorkflowGroups";
import { WorkflowStepGlyph } from "./WorkflowStepGlyph";
import { toastManager } from "../ui/toast";

/** The same workflow actions for live and archived rows, by mouse or keyboard. */
function workflowContextMenuProps(input: {
  workflow: Pick<SidebarWorkflowEntry["workflow"], "id" | "title">;
  type: SidebarWorkflowType;
  archived: boolean;
  onToggleArchive: () => void;
}): Pick<HTMLAttributes<HTMLElement>, "onContextMenu" | "onKeyDownCapture"> {
  const open = async (position: { x: number; y: number }) => {
    const api = readNativeApi();
    if (!api) return;
    try {
      const action = await api.contextMenu.show(
        [
          { id: "archive", label: input.archived ? "Unarchive workflow" : "Archive workflow" },
          { id: "delete", label: "Delete workflow", destructive: true },
        ],
        position,
      );
      if (action === "archive") input.onToggleArchive();
      if (action === "delete") {
        await deleteWorkflow({
          workflowId: input.workflow.id,
          workflowType: input.type,
          workflowTitle: input.workflow.title,
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Workflow action failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };
  return {
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      void open({ x: event.clientX, y: event.clientY });
    },
    onKeyDownCapture: (event) => {
      if (
        event.target !== event.currentTarget ||
        !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      void open({ x: rect.left, y: rect.bottom });
    },
  };
}

export interface SidebarThreadRowIndicators {
  threadStatus: ThreadStatusPill | null;
  prStatus: PrStatusIndicator | null;
  isUnread: boolean;
  /** The thread's git status is being polled but hasn't loaded, so "no PR" isn't known yet. */
  prPending: boolean;
}

/** Row indicators by thread id; any thread in the store, including snoozed and archived ones. */
export type SidebarIndicatorsForThread = (
  thread: Pick<ThreadListItem, "id">,
) => SidebarThreadRowIndicators;

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
 * the archive button's slot, like a thread row's, so the right edges line up. While the PR
 * state is still loading it shows a dashed circle instead of a check that could flip to a PR.
 */
function WorkflowFinishedStatus(props: {
  pr: PrStatusIndicator | null;
  prPending: boolean;
  canOpen: boolean;
  onOpenLastThread: () => void;
}) {
  const { pr } = props;
  const pending = !pr && props.prPending;
  return (
    <span className="flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="workflow-finished-status"
              aria-label={
                pr
                  ? `Open last thread, ${pr.tooltip}`
                  : pending
                    ? "Open last thread, checking for a PR"
                    : "Open last thread"
              }
              {...(pending ? { "data-pr-pending": "" } : {})}
              disabled={!props.canOpen}
              className={cn(
                "-mx-0.5 inline-flex h-5 items-center gap-0.5 rounded-md px-0.5 text-2xs tabular-nums outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
                pr ? pr.colorClass : pending ? "text-faint-foreground" : "text-success-foreground",
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
              ) : pending ? (
                <CircleDashedIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <CheckIcon aria-hidden="true" className="size-3.5" />
              )}
            </button>
          }
        />
        <TooltipPopup side="top">
          {pr ? workflowPrLabel(pr) : pending ? "Completed · checking for a PR" : "Completed"}
        </TooltipPopup>
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

type WorkflowSidebarPhaseGroup = Extract<WorkflowSidebarGroup<ThreadSummary>, { kind: "phase" }>;

/** The expansion key of a workflow's phase group, beside the workflow ids in the same map. */
export function workflowPhaseExpansionKey(workflowId: string, phaseId: string): string {
  return `${workflowId}#${phaseId}`;
}

/** The model chip on workflow step rows: present for the A/B split, quieter until hovered. */
const WORKFLOW_MODEL_CHIP_CLASS_NAME =
  "opacity-60 group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100";

function isNeedsYouStatus(status: ThreadStatusPill | null): boolean {
  return status?.label === "Pending Approval" || status?.label === "Awaiting Input";
}

/**
 * A phase of two or more step threads: its state, label, thread count and newest activity.
 * Clicking (or Enter, Right and Left in the tree) opens and closes its steps. A step that
 * waits on the user shows its status here too, so folding the phase can't hide it.
 */
function SidebarWorkflowPhaseRow(props: {
  rowId: string;
  group: WorkflowSidebarPhaseGroup;
  needsYouStatus: ThreadStatusPill | null;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { group, expanded, needsYouStatus } = props;
  const treeRowProps = useSidebarTreeRowProps(props.rowId);
  const isTreeRow = "data-sidebar-row" in treeRowProps;
  const newestThread = newestActivityThread(group.rows.map((row) => row.thread));
  const emphasized = needsYouStatus !== null || group.state === "active" || group.state === "error";
  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} {...treeRowProps} aria-expanded={expanded} />}
        size="md"
        data-testid={`workflow-phase-row-${group.id}`}
        className={cn(
          resolveThreadRowClassName({ isActive: false, isSelected: false }),
          SIDEBAR_TREE_ROW_HEIGHT_CLASS_NAME,
          emphasized && "text-foreground",
        )}
        onClick={props.onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.onToggle();
        }}
      >
        {needsYouStatus ? (
          <ThreadStatusPillBadge pill={needsYouStatus} variant="icon" live={false} />
        ) : (
          <WorkflowStepGlyph state={group.state} />
        )}
        <span className="min-w-0 flex-1 truncate">
          {group.label}
          <span className="ms-1.5 text-2xs text-faint-foreground tabular-nums">
            {group.rows.length}
            <span className="sr-only"> steps</span>
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs font-normal text-muted-foreground tabular-nums">
          {newestThread ? (
            <ThreadRelativeActivityTime
              threadId={newestThread.id}
              fallback={newestThread.lastInteractionAt}
            />
          ) : null}
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-(--duration-fast)",
              expanded && "rotate-90",
            )}
          />
        </span>
      </SidebarMenuSubButton>
      {expanded ? (
        // Third tree level: the steps sit under the phase's state glyph.
        <SidebarTreeParentContext.Provider value={isTreeRow ? props.rowId : null}>
          <SidebarMenuSub className={cn(SIDEBAR_TREE_LEVEL_CLASS_NAME, "mt-px")}>
            {props.children}
          </SidebarMenuSub>
        </SidebarTreeParentContext.Provider>
      ) : null}
    </SidebarMenuSubItem>
  );
}

/**
 * A phase with no thread yet (upcoming Implementation, Code Review): shown faint so the rest
 * of the pipeline is visible, but not a tree row, since there is nothing to open. The
 * workflow row's phase strip already names it to screen readers.
 */
function SidebarWorkflowPendingRow({
  group,
}: {
  group: Extract<WorkflowSidebarGroup<ThreadSummary>, { kind: "pending" }>;
}) {
  return (
    <SidebarMenuSubItem className="w-full" aria-hidden="true">
      <div
        data-testid={`workflow-pending-phase-${group.id}`}
        className={cn(
          "flex w-full items-center gap-2 px-2 text-ui text-muted-foreground select-none",
          SIDEBAR_TREE_ROW_HEIGHT_CLASS_NAME,
          group.state === "pending" && "opacity-60",
        )}
      >
        <WorkflowStepGlyph state={group.state} />
        <span className="min-w-0 flex-1 truncate">
          {group.label}
          {group.stepCount > 1 ? (
            <span className="ms-1.5 text-2xs text-faint-foreground tabular-nums">
              {group.stepCount}
            </span>
          ) : null}
        </span>
        {group.modelSlot ? (
          <ModelChip model={group.modelSlot.model} provider={group.modelSlot.provider} iconOnly />
        ) : null}
      </div>
    </SidebarMenuSubItem>
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
  /**
   * The sidebar's expansion overrides, for the workflow's phase groups (keyed by
   * `workflowPhaseExpansionKey`); `onToggleCollapsed` toggles those keys too.
   */
  expansionOverrides?: Readonly<Record<string, boolean>> | undefined;
  onToggleCollapsed: (workflowId: string, fallbackExpanded: boolean) => void;
  onArchive: (workflowId: SidebarWorkflowId, title: string, type: SidebarWorkflowType) => void;
  indicatorsForThread: SidebarIndicatorsForThread;
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
  // A finished workflow is one line: its last thread's PR (or a check) replaces the strip.
  // `workflowThreads` leaves out snoozed threads, so the last thread is looked up by id.
  const finished = currentStep?.state === "completed";
  const targetIndicators =
    finished && targetThreadId !== null ? props.indicatorsForThread({ id: targetThreadId }) : null;
  const groups = groupWorkflowThreadsByPhase(
    props.phases ?? [],
    workflowThreads,
    (thread) =>
      props.threadLabels.get(thread.id) ??
      (entry.type === "planning"
        ? workflowThreadDisplayTitle(entry.workflow, thread.title)
        : thread.title),
  );
  // The workflow's outcome: a finished workflow's last thread, or the implementation thread
  // once it has opened a PR while code review still runs.
  const implementationThreadId =
    props.phases
      ?.find((phase) => phase.id === "implementation")
      ?.steps.find((step) => step.threadId !== null)?.threadId ?? null;
  const deliverableThreadId = finished
    ? targetThreadId
    : implementationThreadId !== null &&
        props.indicatorsForThread({ id: implementationThreadId }).prStatus !== null
      ? implementationThreadId
      : null;
  // A finished workflow's time is its newest thread's live activity, not `updatedAt`, which
  // bookkeeping writes move long after the work.
  const newestWorkflowThread = newestActivityThread(workflowThreads);
  /** The first step status in the group that waits on the user, if any. */
  const needsYouStatusOf = (group: WorkflowSidebarPhaseGroup): ThreadStatusPill | null => {
    for (const row of group.rows) {
      const status = props.indicatorsForThread(row.thread).threadStatus;
      if (isNeedsYouStatus(status)) return status;
    }
    return null;
  };
  const defaultPhaseExpanded = (group: WorkflowSidebarPhaseGroup) =>
    group.state === "active" ||
    group.state === "error" ||
    needsYouStatusOf(group) !== null ||
    group.rows.some((row) => row.thread.id === routeThreadId);
  const isPhaseExpanded = (group: WorkflowSidebarPhaseGroup) =>
    props.expansionOverrides?.[workflowPhaseExpansionKey(workflow.id, group.id)] ??
    defaultPhaseExpanded(group);
  // Shift-click ranges follow the rows on screen: grouped, collapsed phases left out.
  const visibleThreadIds = groups.flatMap((group) =>
    group.kind === "pending" || (group.rows.length > 1 && !isPhaseExpanded(group))
      ? []
      : group.rows.map((row) => row.thread.id),
  );
  const renderThreadRow = (row: WorkflowSidebarRow<ThreadSummary>, label: string) => {
    const { thread } = row;
    return (
      <SidebarThreadRow
        key={thread.id}
        thread={thread}
        section="workflow"
        isActive={routeThreadId === thread.id}
        orderedIds={visibleThreadIds}
        displayTitle={label}
        workflowRoleLabel={row.fullLabel}
        workflowTitle={workflow.title}
        workflowStep={
          row.stepState
            ? { state: row.stepState, isDeliverable: thread.id === deliverableThreadId }
            : undefined
        }
        trailingMeta={
          <ModelChip
            model={thread.modelSelection?.model ?? thread.model}
            sessionProviderName={thread.sessionProvider}
            iconOnly
            className={WORKFLOW_MODEL_CHIP_CLASS_NAME}
          />
        }
        isRenaming={false}
        actions={actions}
        {...props.indicatorsForThread(thread)}
      />
    );
  };
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
        {...workflowContextMenuProps({
          workflow,
          type,
          archived: false,
          onToggleArchive: () => props.onArchive(workflow.id, workflow.title, type),
        })}
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
            pr={targetIndicators?.prStatus ?? null}
            prPending={targetIndicators?.prPending ?? false}
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
              {newestWorkflowThread ? (
                <ThreadRelativeActivityTime
                  threadId={newestWorkflowThread.id}
                  fallback={newestWorkflowThread.lastInteractionAt}
                />
              ) : (
                formatRelativeTimeLabel(workflow.updatedAt)
              )}
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
            {groups.map((group) => {
              if (group.kind === "pending") {
                return <SidebarWorkflowPendingRow key={group.id} group={group} />;
              }
              // A phase of one step is that step's row, under its full label.
              if (group.rows.length === 1) {
                const row = group.rows[0]!;
                return renderThreadRow(row, row.fullLabel);
              }
              const phaseKey = workflowPhaseExpansionKey(workflow.id, group.id);
              const expanded = isPhaseExpanded(group);
              return (
                <SidebarWorkflowPhaseRow
                  key={group.id}
                  rowId={`workflow-phase:${workflow.id}:${group.id}`}
                  group={group}
                  needsYouStatus={needsYouStatusOf(group)}
                  expanded={expanded}
                  onToggle={() => props.onToggleCollapsed(phaseKey, defaultPhaseExpanded(group))}
                >
                  {group.rows.map((row) => renderThreadRow(row, row.label))}
                </SidebarWorkflowPhaseRow>
              );
            })}
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
          !isActive && SIDEBAR_DONE_ROW_CLASS_NAME,
        )}
        data-row-done
        onClick={openWorkflow}
        {...workflowContextMenuProps({
          workflow,
          type,
          archived: true,
          onToggleArchive: () => props.onUnarchive(workflow.id, type),
        })}
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
