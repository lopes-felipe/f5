import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { WorkflowTimelineStepState } from "./workflowTimelineTypes";

const STATE_GLYPH: Record<
  WorkflowTimelineStepState,
  { readonly icon: LucideIcon; readonly label: string; readonly className: string }
> = {
  completed: { icon: CircleCheckIcon, label: "Done", className: "text-success-foreground" },
  active: {
    icon: CircleDotIcon,
    label: "Running",
    className: "text-info-foreground motion-safe:animate-status-pulse",
  },
  pending: { icon: CircleIcon, label: "Not started", className: "text-faint-foreground" },
  skipped: { icon: CircleDashedIcon, label: "Skipped", className: "text-faint-foreground" },
  error: { icon: CircleAlertIcon, label: "Failed", className: "text-destructive-foreground" },
};

export function workflowStateLabel(state: WorkflowTimelineStepState): string {
  return STATE_GLYPH[state].label;
}

/** Phase or step state as a token-coloured glyph with an sr-only label. */
export function WorkflowStateGlyph(props: {
  readonly state: WorkflowTimelineStepState;
  readonly className?: string | undefined;
}) {
  const { icon: Icon, label, className } = STATE_GLYPH[props.state];
  return (
    <span
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", props.className)}
    >
      <Icon aria-hidden="true" className={cn("size-3.5", className)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
