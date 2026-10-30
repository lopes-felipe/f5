import type { ProjectId } from "@t3tools/contracts";
import { MessageSquarePlusIcon, SquarePenIcon, WorkflowIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { NewThreadModifiers } from "./useSidebarThreadActions";

/**
 * "New thread" and "New workflow" for the primary project (the open thread's
 * project, else the most recent, else the first). With no context New thread starts scratch.
 */
export function SidebarPrimaryActions(props: {
  projectId: ProjectId | null;
  newThreadShortcutLabel: string | null;
  workflowShortcutLabel: string | null;
  onNewThread: (projectId: ProjectId | null, modifiers: NewThreadModifiers) => void;
  onNewScratchThread?: ((modifiers: NewThreadModifiers) => void) | undefined;
  scratchShortcutLabel: string | null;
  scratchDisabled: boolean;
  onNewWorkflow: (projectId: ProjectId) => void;
  onAddProject: () => void;
}) {
  const { projectId } = props;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 pb-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              data-testid="sidebar-new-thread"
              disabled={projectId === null && props.scratchDisabled}
              className="h-8 min-w-0 flex-[1_1_10rem] justify-start gap-2 bg-background px-2.5 text-foreground"
              onClick={(event) => {
                props.onNewThread(projectId, {
                  shiftKey: event.shiftKey,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                });
              }}
            >
              <SquarePenIcon aria-hidden="true" className="size-4" />
              <span className="flex-1 truncate text-left text-ui">New thread</span>
              {props.newThreadShortcutLabel ? <Kbd>{props.newThreadShortcutLabel}</Kbd> : null}
            </Button>
          }
        />
        <TooltipPopup side="bottom" className="max-w-64 whitespace-normal">
          {projectId
            ? "Shift-click uses the other workspace mode; Cmd/Ctrl+Shift-click opens a new window."
            : "Starts a thread without a project. Cmd/Ctrl+Shift-click opens a new window."}
        </TooltipPopup>
      </Tooltip>
      {props.onNewScratchThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="New thread without a project"
                data-testid="sidebar-new-scratch-thread"
                className="size-8 bg-background text-muted-foreground hover:text-foreground"
                disabled={props.scratchDisabled}
                onClick={(event) =>
                  props.onNewScratchThread?.({
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                  })
                }
              >
                <MessageSquarePlusIcon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom" className="flex items-center gap-2">
            New thread without a project
            {props.scratchShortcutLabel ? <Kbd>{props.scratchShortcutLabel}</Kbd> : null}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="New workflow"
              data-testid="sidebar-new-workflow"
              className="size-8 bg-background text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (!projectId) {
                  props.onAddProject();
                  return;
                }
                props.onNewWorkflow(projectId);
              }}
            >
              <WorkflowIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom" className="flex items-center gap-2">
          New workflow
          {props.workflowShortcutLabel ? <Kbd>{props.workflowShortcutLabel}</Kbd> : null}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
