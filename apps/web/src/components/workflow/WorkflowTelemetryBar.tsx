import { ActivityIcon, ClockIcon, CoinsIcon, FlameIcon, GaugeIcon } from "lucide-react";

import { formatUsd } from "../../lib/formatUsd";
import { formatCompactTokenCount, type WorkflowRunTelemetry } from "./workflowTelemetry";

export function WorkflowTelemetryBar(props: {
  readonly telemetry: WorkflowRunTelemetry;
  readonly totalCostUsd?: number | null | undefined;
}) {
  const { telemetry } = props;
  if (telemetry.totalSteps === 0) {
    return null;
  }

  const costLabel =
    props.totalCostUsd !== null && props.totalCostUsd !== undefined && props.totalCostUsd > 0
      ? formatUsd(props.totalCostUsd)
      : null;

  return (
    <section
      aria-label="Workflow telemetry"
      data-slot="workflow-telemetry-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-2xs text-muted-foreground"
    >
      <span
        data-slot="workflow-telemetry-progress"
        className="inline-flex items-center gap-1.5 font-medium text-foreground tabular-nums"
      >
        <ActivityIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span>
          {telemetry.completedSteps}/{telemetry.totalSteps} steps
        </span>
        {telemetry.activeSteps > 0 ? (
          <span className="text-info-foreground">· {telemetry.activeSteps} running</span>
        ) : null}
        {telemetry.errorSteps > 0 ? (
          <span className="text-destructive-foreground">· {telemetry.errorSteps} failed</span>
        ) : null}
      </span>

      {telemetry.totalElapsedLabel ? (
        <span
          data-slot="workflow-telemetry-elapsed"
          className="inline-flex items-center gap-1 tabular-nums"
        >
          <ClockIcon aria-hidden="true" className="size-3.5" />
          <span>Elapsed {telemetry.totalElapsedLabel}</span>
        </span>
      ) : null}

      {telemetry.totalContextTokens > 0 ? (
        <span
          data-slot="workflow-telemetry-tokens"
          className="inline-flex items-center gap-1 tabular-nums"
        >
          <GaugeIcon aria-hidden="true" className="size-3.5" />
          <span>~{formatCompactTokenCount(telemetry.totalContextTokens)} context</span>
        </span>
      ) : null}

      {costLabel ? (
        <span
          data-slot="workflow-telemetry-cost"
          className="inline-flex items-center gap-1 tabular-nums"
        >
          <CoinsIcon aria-hidden="true" className="size-3.5" />
          <span>{costLabel}</span>
        </span>
      ) : null}

      {telemetry.slowestStep ? (
        <span
          data-slot="workflow-telemetry-bottleneck"
          className="inline-flex items-center gap-1 tabular-nums"
        >
          <FlameIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
          <span>
            Slowest:{" "}
            <strong className="font-medium text-foreground">{telemetry.slowestStep.label}</strong> (
            {telemetry.slowestStep.elapsedLabel})
          </span>
        </span>
      ) : null}
    </section>
  );
}
