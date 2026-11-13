import { CheckIcon, CircleAlertIcon, CircleDashedIcon, LoaderIcon } from "lucide-react";

import { synchronizeStatusPulse } from "../../lib/statusPulse";
import { cn } from "../../lib/utils";
import type { WorkflowSidebarStepState } from "./sidebarWorkflowGroups";

const WORKFLOW_STEP_GLYPH: Record<
  WorkflowSidebarStepState,
  { icon: typeof CheckIcon; label: string; className: string }
> = {
  // Done recedes, so color only marks a step that is running or needs someone.
  completed: { icon: CheckIcon, label: "Done", className: "text-muted-foreground" },
  active: {
    icon: LoaderIcon,
    label: "Running",
    className: "text-info-foreground motion-safe:animate-status-pulse",
  },
  error: {
    icon: CircleAlertIcon,
    label: "Needs attention",
    className: "text-destructive-foreground",
  },
  pending: { icon: CircleDashedIcon, label: "Pending", className: "text-faint-foreground" },
};

/** A workflow step's state in a sidebar row's 16px leading slot. */
export function WorkflowStepGlyph({ state }: { state: WorkflowSidebarStepState }) {
  const { icon: Icon, label, className } = WORKFLOW_STEP_GLYPH[state];
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center"
      title={label}
      data-workflow-step-state={state}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5", className)}
        onAnimationStart={state === "active" ? synchronizeStatusPulse : undefined}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
