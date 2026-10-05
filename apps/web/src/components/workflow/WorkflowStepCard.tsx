import type { ProviderKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { deriveWorkLogEntries } from "../../session-logic";
import { resolveThreadStatusPillForThread, type ThreadStatusPill } from "../../threadStatus";
import type { Thread } from "../../types";
import { ModelChip } from "../chat/ModelChip";
import { normalizedWorkEntryHeading } from "../chat/MessagesTimeline.logic";
import { ThreadStatusPillBadge } from "../thread/ThreadStatusPillBadge";
import { WorkflowStateGlyph } from "./WorkflowStateGlyph";
import type { WorkflowTimelineStep } from "./workflowTimelineTypes";

export interface WorkflowStepCardModel {
  readonly label: string;
  /** A visible thread status (Working, Needs approval...) wins over the step state. */
  readonly pill: ThreadStatusPill | null;
  readonly model: {
    readonly model: string;
    readonly provider: ProviderKind | null;
    readonly sessionProviderName: string | null;
  } | null;
  /** What the step's thread is doing right now; only for running steps. */
  readonly activity: string | null;
}

/** Heading of the thread's latest work-log entry ("Read src/app.ts", "Ran bun test"...). */
export function resolveLatestWorkHeading(thread: Thread): string | null {
  if (thread.activities.length === 0) return null;
  const entries = deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId ?? undefined);
  const latest = entries.at(-1);
  if (!latest) return null;
  const heading = normalizedWorkEntryHeading(latest);
  return heading.length > 0 ? heading : null;
}

export function resolveWorkflowStepCardModel(input: {
  readonly step: WorkflowTimelineStep;
  readonly thread: Thread | null | undefined;
  readonly includeActivity?: boolean | undefined;
}): WorkflowStepCardModel {
  const { step, thread } = input;
  // The thread's actual model once it exists; the configured slot before.
  const model = thread
    ? {
        model: thread.model,
        provider: null,
        sessionProviderName: thread.session?.provider ?? null,
      }
    : step.modelSlot
      ? {
          model: step.modelSlot.model,
          provider: step.modelSlot.provider,
          sessionProviderName: null,
        }
      : null;
  return {
    label: step.label,
    pill: thread ? resolveThreadStatusPillForThread(thread) : null,
    model,
    activity:
      input.includeActivity && thread && step.state === "active"
        ? resolveLatestWorkHeading(thread)
        : null,
  };
}

/**
 * One workflow step: status, role label and model, linking to the step's
 * thread. `row` is the dense list form; `card` is the board form, which also
 * shows a live activity line while the step runs.
 */
export function WorkflowStepCard(props: {
  readonly step: WorkflowTimelineStep;
  readonly thread: Thread | null | undefined;
  readonly variant?: "row" | "card" | undefined;
}) {
  const variant = props.variant ?? "row";
  const { step } = props;
  const model = resolveWorkflowStepCardModel({
    step,
    thread: props.thread,
    includeActivity: variant === "card",
  });
  const dimmed = step.state === "pending" || step.state === "skipped";

  const status = model.pill ? (
    <ThreadStatusPillBadge pill={model.pill} variant="icon" live={false} />
  ) : (
    <WorkflowStateGlyph state={step.state} />
  );
  const modelChip = model.model ? (
    <ModelChip
      model={model.model.model}
      provider={model.model.provider}
      sessionProviderName={model.model.sessionProviderName}
      className="max-w-36"
    />
  ) : null;

  const content =
    variant === "card" ? (
      <>
        <span className="flex min-w-0 items-center gap-2">
          {status}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              step.state === "skipped" && "line-through",
            )}
          >
            {model.label}
          </span>
        </span>
        {modelChip ? <span className="flex min-w-0 ps-6">{modelChip}</span> : null}
        {model.activity ? (
          <span
            data-slot="workflow-step-activity"
            className="flex min-w-0 items-center gap-1.5 ps-6 text-2xs text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-info motion-safe:animate-status-pulse"
            />
            <span className="truncate">{model.activity}</span>
          </span>
        ) : null}
      </>
    ) : (
      <>
        {status}
        <span className={cn("min-w-0 flex-1 truncate", step.state === "skipped" && "line-through")}>
          {model.label}
        </span>
        {modelChip}
      </>
    );

  const className = cn(
    "outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
    variant === "card"
      ? "flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-2.5 shadow-xs/5"
      : "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm",
    variant === "card" && (step.state === "error" ? "border-destructive/40" : "border-border"),
    dimmed ? "text-muted-foreground" : "text-foreground",
    step.threadId ? "hover:bg-accent/60" : "cursor-default",
  );

  if (!step.threadId) {
    return (
      <div data-slot="workflow-step" data-step-state={step.state} className={className}>
        {content}
      </div>
    );
  }
  return (
    <Link
      to="/$threadId"
      params={{ threadId: step.threadId }}
      data-slot="workflow-step"
      data-step-state={step.state}
      className={className}
    >
      {content}
    </Link>
  );
}
