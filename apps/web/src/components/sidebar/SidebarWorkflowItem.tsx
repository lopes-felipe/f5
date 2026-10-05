import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
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
import type { Thread } from "../../types";
import { ModelChip } from "../chat/ModelChip";
import { resolveThreadRowClassName, resolveWorkflowThreadListExpanded } from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { WorkflowOverallState } from "../workflow/workflowTimelineTypes";
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

export interface SidebarThreadRowIndicators {
  threadStatus: ThreadStatusPill | null;
  prStatus: PrStatusIndicator | null;
  terminalStatus: TerminalStatusIndicator | null;
}

const WORKFLOW_STATE_ICON: Record<
  Exclude<WorkflowOverallState, "pending">,
  { icon: typeof CheckIcon; label: string; className: string }
> = {
  active: {
    icon: LoaderIcon,
    label: "Running",
    className: "text-info-foreground animate-status-pulse",
  },
  error: {
    icon: CircleAlertIcon,
    label: "Needs attention",
    className: "text-destructive-foreground",
  },
  completed: { icon: CheckIcon, label: "Completed", className: "text-success-foreground" },
};

function WorkflowStateIcon({ state }: { state: WorkflowOverallState }) {
  if (state === "pending") return null;
  const { icon: Icon, label, className } = WORKFLOW_STATE_ICON[state];
  return (
    <span title={label} className="inline-flex size-4 shrink-0 items-center justify-center">
      <Icon aria-hidden="true" className={cn("size-3.5", className)} />
      <span className="sr-only">{label}</span>
    </span>
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
  workflowThreads: readonly Thread[];
  /** Role label per thread from the workflow's phases. */
  threadLabels: ReadonlyMap<ThreadId, string>;
  overallState: WorkflowOverallState;
  pathname: string;
  routeThreadId: ThreadId | null;
  expandByDefault: boolean;
  overrideExpanded: boolean | undefined;
  onToggleCollapsed: (workflowId: string, fallbackExpanded: boolean) => void;
  onArchive: (workflowId: SidebarWorkflowId, title: string, type: SidebarWorkflowType) => void;
  indicatorsForThread: (thread: Thread) => SidebarThreadRowIndicators;
  actions: SidebarThreadActions;
}) {
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
  });
  const workflowExpanded = resolveWorkflowThreadListExpanded({
    overrideExpanded: props.overrideExpanded,
    expandByDefault: props.expandByDefault,
    activeThreadId: routeThreadId,
    workflowThreadIds: orderedWorkflowThreadIds,
  });
  const workflowCollapsed = !workflowExpanded;
  const typeLabel = workflowTypeLabel(type, workflow);
  const openWorkflow = () => {
    void navigate({
      to: workflowRoute,
      params: { workflowId: workflow.id },
    });
  };

  return (
    <SidebarMenuSubItem className="group/workflow-row relative w-full">
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
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
        <WorkflowStateIcon state={props.overallState} />
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
      {!workflowCollapsed && workflowThreads.length > 0 ? (
        <SidebarMenuSub className="mx-0 mt-px mb-0 w-full translate-x-0 gap-px border-l-0 px-0 py-0">
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
                  sessionProviderName={thread.session?.provider ?? null}
                  iconOnly
                />
              }
              isRenaming={false}
              actions={actions}
              {...props.indicatorsForThread(thread)}
            />
          ))}
        </SidebarMenuSub>
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
  const openWorkflow = () => {
    void navigate({
      to: workflowRoute,
      params: { workflowId: workflow.id },
    });
  };

  return (
    <SidebarMenuSubItem className="group/thread-row w-full">
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
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
