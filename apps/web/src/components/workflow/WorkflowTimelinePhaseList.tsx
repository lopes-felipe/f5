import { Circle, CircleAlert, CircleCheckBig, CircleDot } from "lucide-react";

import { cn } from "../../lib/utils";
import { type Thread } from "../../types";
import { WorkflowThreadLinkRow } from "./WorkflowThreadLinkRow";
import {
  type WorkflowTimelinePhase,
  type WorkflowTimelinePhaseState,
} from "./workflowTimelineTypes";

const PHASE_ICON = {
  completed: CircleCheckBig,
  active: CircleDot,
  pending: Circle,
  error: CircleAlert,
} as const;

const PHASE_ICON_CLASS: Record<WorkflowTimelinePhaseState, string> = {
  completed: "text-emerald-500",
  active: "text-primary animate-pulse",
  pending: "text-muted-foreground/30",
  error: "text-red-500",
};

const PHASE_LABEL_CLASS: Record<WorkflowTimelinePhaseState, string> = {
  completed: "text-foreground",
  active: "text-foreground font-semibold",
  pending: "text-muted-foreground/50",
  error: "text-red-500",
};

export function WorkflowTimelinePhaseList(props: {
  phases: readonly WorkflowTimelinePhase[];
  threadById: ReadonlyMap<Thread["id"], Thread>;
}) {
  return (
    <div>
      {props.phases.map((phase, phaseIndex) => {
        const isLast = phaseIndex === props.phases.length - 1;
        const Icon = PHASE_ICON[phase.state];
        const borderColor = phase.state === "completed" ? "border-emerald-500/30" : "border-border";

        return (
          <div key={phase.id}>
            <div className="flex items-center gap-2 py-2">
              <Icon size={18} className={PHASE_ICON_CLASS[phase.state]} />
              <span className={cn("text-sm", PHASE_LABEL_CLASS[phase.state])}>{phase.label}</span>
            </div>

            <div
              className={cn(
                "ml-[8px] border-l-2 pb-2 pl-4",
                isLast ? "border-transparent" : borderColor,
              )}
            >
              <div className="space-y-2 text-sm">
                {phase.steps.map((step) => (
                  <WorkflowThreadLinkRow
                    key={step.key}
                    threadId={step.threadId}
                    thread={step.threadId ? props.threadById.get(step.threadId) : undefined}
                    threadTitleDisplay={
                      step.threadId
                        ? (props.threadById.get(step.threadId)?.title ?? undefined)
                        : undefined
                    }
                    fallbackLabel={step.label}
                    stepState={step.state}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
