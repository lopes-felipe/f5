import { cn } from "../../lib/utils";
import { type Thread } from "../../types";
import { WorkflowStateGlyph } from "./WorkflowStateGlyph";
import { WorkflowStepCard } from "./WorkflowStepCard";
import { type WorkflowTimelinePhase } from "./workflowTimelineTypes";

/** List form of a workflow: phases top to bottom, each with its step rows. */
export function WorkflowTimelinePhaseList(props: {
  phases: readonly WorkflowTimelinePhase[];
  threadById: ReadonlyMap<Thread["id"], Thread>;
}) {
  return (
    <ol data-slot="workflow-phase-list" aria-label="Workflow steps" className="flex flex-col">
      {props.phases.map((phase, phaseIndex) => {
        const isLast = phaseIndex === props.phases.length - 1;
        const dimmed = phase.state === "pending" || phase.state === "skipped";
        return (
          <li key={phase.id} data-phase-state={phase.state}>
            <div className="flex h-8 items-center gap-2 px-2">
              <WorkflowStateGlyph state={phase.state} />
              <span
                className={cn(
                  "text-ui font-medium",
                  dimmed ? "text-muted-foreground" : "text-foreground",
                  phase.state === "skipped" && "line-through",
                  phase.state === "error" && "text-destructive-foreground",
                )}
              >
                {phase.label}
              </span>
            </div>
            {phase.steps.length > 0 ? (
              <div
                className={cn(
                  "ms-4 border-s ps-2 pb-2",
                  isLast
                    ? "border-transparent"
                    : phase.state === "completed"
                      ? "border-success/30"
                      : "border-border",
                )}
              >
                {phase.steps.map((step) => (
                  <WorkflowStepCard
                    key={step.key}
                    step={step}
                    thread={step.threadId ? props.threadById.get(step.threadId) : undefined}
                  />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
