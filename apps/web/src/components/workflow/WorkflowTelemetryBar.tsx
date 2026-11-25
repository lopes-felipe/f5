import { ActivityIcon, ClockIcon, FlameIcon, GaugeIcon } from "lucide-react";

import { useNowIso } from "../../lib/nowTicker";
import { formatElapsed } from "../../session-logic";
import { formatCompactTokens } from "../chat/composer/contextMeter.logic";
import type { WorkflowRunTelemetry } from "./workflowTelemetry";

function LiveRunElapsed(props: { readonly startIso: string }) {
  const nowIso = useNowIso(true);
  const label = formatElapsed(props.startIso, nowIso);
  if (!label) return null;
  return (
    <span
      data-slot="workflow-telemetry-elapsed"
      className="inline-flex items-center gap-1 tabular-nums"
    >
      <ClockIcon aria-hidden="true" className="size-3.5" />
      <span>Elapsed {label}</span>
    </span>
  );
}

export function WorkflowTelemetryBar(props: { readonly telemetry: WorkflowRunTelemetry }) {
  const { telemetry } = props;
  if (telemetry.totalSteps === 0) {
    return null;
  }

  const threadLabel = telemetry.contextThreadCount === 1 ? "thread" : "threads";

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

      {telemetry.isRunLive ? (
        <LiveRunElapsed startIso={telemetry.runStartIso} />
      ) : telemetry.totalElapsedLabel ? (
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
          <span>
            ~{formatCompactTokens(telemetry.totalContextTokens)} context in use across{" "}
            {telemetry.contextThreadCount} {threadLabel}
          </span>
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
