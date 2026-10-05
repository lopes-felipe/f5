import { cn } from "../../lib/utils";
import { type Thread } from "../../types";
import { ScrollArea } from "../ui/scroll-area";
import { WorkflowStateGlyph } from "./WorkflowStateGlyph";
import { WorkflowStepCard } from "./WorkflowStepCard";
import { type WorkflowTimelinePhase } from "./workflowTimelineTypes";

/**
 * Board form of a workflow: one column per phase, left to right, each with
 * its step cards. Many phases scroll horizontally.
 */
export function WorkflowBoard(props: {
  phases: readonly WorkflowTimelinePhase[];
  threadById: ReadonlyMap<Thread["id"], Thread>;
}) {
  return (
    <ScrollArea className="h-auto" scrollbarGutter>
      <ol
        data-slot="workflow-board"
        aria-label="Workflow steps"
        className="flex w-max min-w-full gap-3"
      >
        {props.phases.map((phase) => {
          const dimmed = phase.state === "pending" || phase.state === "skipped";
          return (
            <li
              key={phase.id}
              data-slot="workflow-board-column"
              data-phase-state={phase.state}
              className={cn(
                "flex w-60 shrink-0 flex-col gap-2 rounded-xl border p-2",
                phase.state === "active"
                  ? "border-info/30 bg-info/5"
                  : phase.state === "error"
                    ? "border-destructive/30 bg-destructive/5"
                    : "border-border bg-muted/40",
              )}
            >
              <div className="flex h-7 items-center gap-2 px-1">
                <WorkflowStateGlyph state={phase.state} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-ui font-medium",
                    dimmed ? "text-muted-foreground" : "text-foreground",
                    phase.state === "skipped" && "line-through",
                  )}
                >
                  {phase.label}
                </span>
                {phase.steps.length > 0 ? (
                  <span className="text-2xs tabular-nums text-muted-foreground">
                    {phase.steps.filter((step) => step.state === "completed").length}/
                    {phase.steps.length}
                  </span>
                ) : null}
              </div>
              {phase.steps.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {phase.steps.map((step) => (
                    <WorkflowStepCard
                      key={step.key}
                      step={step}
                      thread={step.threadId ? props.threadById.get(step.threadId) : undefined}
                      variant="card"
                    />
                  ))}
                </div>
              ) : (
                <p className="px-1 pb-1 text-2xs text-muted-foreground">Starts later</p>
              )}
            </li>
          );
        })}
      </ol>
    </ScrollArea>
  );
}
