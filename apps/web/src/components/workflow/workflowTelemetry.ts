import { formatElapsed } from "../../session-logic";
import type { Thread } from "../../types";
import type {
  WorkflowOverallState,
  WorkflowTimelinePhase,
  WorkflowTimelineStep,
  WorkflowTimelineStepState,
} from "./workflowTimelineTypes";

export interface StepTelemetry {
  readonly stepKey: string;
  readonly label: string;
  readonly phaseId: string;
  readonly state: WorkflowTimelineStepState;
  readonly durationMs: number | null;
  readonly elapsedLabel: string | null;
  readonly contextTokens: number | null;
  readonly isBottleneck: boolean;
}

export interface WorkflowBottleneckSummary {
  readonly stepKey: string;
  readonly label: string;
  readonly durationMs: number;
  readonly elapsedLabel: string;
}

export interface WorkflowRunTelemetry {
  readonly completedSteps: number;
  readonly activeSteps: number;
  readonly errorSteps: number;
  readonly totalSteps: number;
  readonly totalContextTokens: number;
  readonly totalElapsedLabel: string | null;
  readonly slowestStep: WorkflowBottleneckSummary | null;
  readonly stepTelemetryByKey: ReadonlyMap<string, StepTelemetry>;
}

const BOTTLENECK_MIN_DURATION_MS = 5_000;
const BOTTLENECK_MIN_RATIO = 1.5;

export function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0 tok";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k tok`;
  }
  return `${Math.round(tokens)} tok`;
}

function resolveStepTimeBounds(
  step: WorkflowTimelineStep,
  thread: Thread | null | undefined,
  nowIso: string,
): { readonly startIso: string; readonly endIso: string } | null {
  if (!thread || step.state === "pending" || step.state === "skipped") {
    return null;
  }

  const startIso = thread.latestTurn?.requestedAt ?? thread.session?.createdAt ?? thread.createdAt;
  if (!startIso) {
    return null;
  }

  const endIso =
    step.state === "active"
      ? nowIso
      : (thread.latestTurn?.completedAt ??
        thread.session?.updatedAt ??
        thread.lastInteractionAt ??
        nowIso);

  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }

  return { startIso, endIso };
}

export function resolveStepDuration(
  step: WorkflowTimelineStep,
  thread: Thread | null | undefined,
  nowIso: string,
): { readonly durationMs: number; readonly elapsedLabel: string } | null {
  const bounds = resolveStepTimeBounds(step, thread, nowIso);
  if (!bounds) {
    return null;
  }
  const durationMs = Date.parse(bounds.endIso) - Date.parse(bounds.startIso);
  const elapsedLabel = formatElapsed(bounds.startIso, bounds.endIso);
  if (!elapsedLabel) {
    return null;
  }
  return { durationMs, elapsedLabel };
}

export function computeWorkflowRunTelemetry(input: {
  readonly phases: ReadonlyArray<WorkflowTimelinePhase>;
  readonly threadById: ReadonlyMap<Thread["id"], Thread>;
  readonly overallState: WorkflowOverallState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nowIso: string;
}): WorkflowRunTelemetry {
  const stepTelemetryByKey = new Map<string, StepTelemetry>();
  const countedThreadIds = new Set<string>();
  let completedSteps = 0;
  let activeSteps = 0;
  let errorSteps = 0;
  let totalSteps = 0;
  let totalContextTokens = 0;
  let slowestStep: WorkflowBottleneckSummary | null = null;

  for (const phase of input.phases) {
    if (phase.state === "skipped") {
      continue;
    }

    const phaseEntries: Array<{
      readonly step: WorkflowTimelineStep;
      readonly durationMs: number | null;
      readonly elapsedLabel: string | null;
      readonly contextTokens: number | null;
    }> = [];

    for (const step of phase.steps) {
      if (step.state === "skipped") {
        continue;
      }

      totalSteps += 1;
      if (step.state === "completed") completedSteps += 1;
      else if (step.state === "active") activeSteps += 1;
      else if (step.state === "error") errorSteps += 1;

      const thread = step.threadId ? input.threadById.get(step.threadId) : undefined;
      const duration = resolveStepDuration(step, thread, input.nowIso);
      const contextTokens =
        thread?.estimatedContextTokens !== null &&
        thread?.estimatedContextTokens !== undefined &&
        thread.estimatedContextTokens > 0
          ? thread.estimatedContextTokens
          : null;

      if (thread && contextTokens !== null && !countedThreadIds.has(thread.id)) {
        countedThreadIds.add(thread.id);
        totalContextTokens += contextTokens;
      }

      if (duration && (!slowestStep || duration.durationMs > slowestStep.durationMs)) {
        slowestStep = {
          stepKey: step.key,
          label: step.label,
          durationMs: duration.durationMs,
          elapsedLabel: duration.elapsedLabel,
        };
      }

      phaseEntries.push({
        step,
        durationMs: duration?.durationMs ?? null,
        elapsedLabel: duration?.elapsedLabel ?? null,
        contextTokens,
      });
    }

    // Identify a bottleneck only among parallel steps in the same phase.
    const measured = phaseEntries.filter(
      (entry): entry is typeof entry & { readonly durationMs: number } => entry.durationMs !== null,
    );
    let bottleneckKey: string | null = null;
    if (measured.length >= 2) {
      const sorted = [...measured].sort((left, right) => left.durationMs - right.durationMs);
      const fastest = sorted[0]!;
      const slowest = sorted.at(-1)!;
      const secondSlowest = sorted.at(-2)!;
      if (
        slowest.durationMs >= BOTTLENECK_MIN_DURATION_MS &&
        slowest.durationMs > secondSlowest.durationMs &&
        (fastest.durationMs === 0 ||
          slowest.durationMs >= fastest.durationMs * BOTTLENECK_MIN_RATIO)
      ) {
        bottleneckKey = slowest.step.key;
      }
    }

    for (const entry of phaseEntries) {
      stepTelemetryByKey.set(entry.step.key, {
        stepKey: entry.step.key,
        label: entry.step.label,
        phaseId: phase.id,
        state: entry.step.state,
        durationMs: entry.durationMs,
        elapsedLabel: entry.elapsedLabel,
        contextTokens: entry.contextTokens,
        isBottleneck: bottleneckKey === entry.step.key,
      });
    }
  }

  const totalElapsedLabel = formatElapsed(
    input.createdAt,
    input.overallState === "active" ? input.nowIso : input.updatedAt,
  );

  return {
    completedSteps,
    activeSteps,
    errorSteps,
    totalSteps,
    totalContextTokens,
    totalElapsedLabel,
    slowestStep,
    stepTelemetryByKey,
  };
}
