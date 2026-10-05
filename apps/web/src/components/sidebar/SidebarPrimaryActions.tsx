import type { ProjectId } from "@t3tools/contracts";
import { SquarePenIcon, WorkflowIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { NewThreadModifiers } from "./useSidebarThreadActions";

/**
 * "New thread" and "New workflow" for the primary project (the open thread's
 * project, else the most recent, else the first). Without projects both start
 * the add-project flow.
 */
export function SidebarPrimaryActions(props: {
  projectId: ProjectId | null;
  newThreadShortcutLabel: string | null;
  workflowShortcutLabel: string | null;
  onNewThread: (projectId: ProjectId, modifiers: NewThreadModifiers) => void;
  onNewWorkflow: (projectId: ProjectId) => void;
  onAddProject: () => void;
}) {
  const { projectId } = props;
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              data-testid="sidebar-new-thread"
              className="h-8 min-w-0 flex-1 justify-start gap-2 bg-background px-2.5 text-foreground"
              onClick={(event) => {
                if (!projectId) {
                  props.onAddProject();
                  return;
                }
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
            : "Add a project to start a thread."}
        </TooltipPopup>
      </Tooltip>
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
