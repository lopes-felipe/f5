import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { type Thread } from "../../types";
import { ScrollArea } from "../ui/scroll-area";
import { WorkflowStateGlyph } from "./WorkflowStateGlyph";
import { WorkflowStepCard } from "./WorkflowStepCard";
import type { StepTelemetry } from "./workflowTelemetry";
import { type WorkflowTimelinePhase } from "./workflowTimelineTypes";

/**
 * Board form of a workflow: one column per phase, left to right, each with
 * its step cards. Many phases scroll horizontally. Supports ArrowLeft,
 * ArrowRight, Home, and End keyboard navigation across focusable step cards.
 */
export function WorkflowBoard(props: {
  phases: readonly WorkflowTimelinePhase[];
  threadById: ReadonlyMap<Thread["id"], Thread>;
  stepTelemetryByKey?: ReadonlyMap<string, StepTelemetry> | undefined;
}) {
  const handleBoardKeyDown = useCallback((event: ReactKeyboardEvent<HTMLOListElement>) => {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const focusableSteps = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('a[data-slot="workflow-step"]'),
    );
    if (focusableSteps.length === 0) {
      return;
    }

    const currentIndex = focusableSteps.findIndex((el) => el === document.activeElement);
    if (currentIndex === -1) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % focusableSteps.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + focusableSteps.length) % focusableSteps.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = focusableSteps.length - 1;
    }

    const nextTarget = focusableSteps[nextIndex];
    if (nextTarget) {
      event.preventDefault();
      nextTarget.focus();
    }
  }, []);

  return (
    <ScrollArea className="h-auto" scrollbarGutter>
      <ol
        data-slot="workflow-board"
        aria-label="Workflow steps"
        onKeyDown={handleBoardKeyDown}
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
                      telemetry={props.stepTelemetryByKey?.get(step.key)}
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
