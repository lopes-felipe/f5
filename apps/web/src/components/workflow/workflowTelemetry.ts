import type { ThreadId } from "@t3tools/contracts";

import { formatElapsed } from "../../session-logic";
import type { Thread } from "../../types";
import type {
  WorkflowTimelinePhase,
  WorkflowTimelineStep,
  WorkflowTimelineStepState,
} from "./workflowTimelineTypes";

export interface StepTelemetry {
  readonly stepKey: string;
  readonly label: string;
  readonly phaseId: string;
  readonly state: WorkflowTimelineStepState;
  readonly startIso: string | null;
  readonly endIso: string | null;
  readonly isLive: boolean;
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
  readonly contextThreadCount: number;
  readonly runStartIso: string;
  readonly runSettledEndIso: string | null;
  readonly isRunLive: boolean;
  readonly totalElapsedLabel: string | null;
  readonly slowestStep: WorkflowBottleneckSummary | null;
  readonly stepTelemetryByKey: ReadonlyMap<string, StepTelemetry>;
}

const BOTTLENECK_MIN_DURATION_MS = 5_000;
const BOTTLENECK_MIN_RATIO = 1.5;

interface StepTiming {
  readonly startIso: string;
  readonly endIso: string | null;
  readonly isLive: boolean;
  readonly durationMs: number | null;
  readonly elapsedLabel: string | null;
}

/**
 * Resolves a step's timing strictly from its own turn. When a thread is shared
 * across multiple steps (e.g. Authoring + Revision, Merge + Polish), a step
 * never reads another turn's timestamps and returns `null` once the thread
 * moves on to a different turn. Non-active steps without a recorded
 * `completedAt` also return `null` instead of falling back to mutable times.
 */
export function resolveStepTiming(
  step: WorkflowTimelineStep,
  thread: Thread | null | undefined,
  options?: {
    readonly isSharedThread?: boolean;
    readonly otherStepTurnIds?: ReadonlySet<string>;
  },
): StepTiming | null {
  if (!thread || step.state === "pending" || step.state === "skipped") {
    return null;
  }

  const latestTurn = thread.latestTurn;
  if (!latestTurn) {
    return null;
  }

  const isShared = options?.isSharedThread ?? false;

  if (step.state === "active") {
    // Do not read a previous finished turn's `requestedAt` before the active step's
    // own turn has actually started.
    if (latestTurn.state !== "running" || latestTurn.completedAt !== null) {
      return null;
    }
    if (step.turnId && latestTurn.turnId !== step.turnId) {
      return null;
    }
    if (isShared && options?.otherStepTurnIds?.has(latestTurn.turnId)) {
      return null;
    }
    const startMs = Date.parse(latestTurn.requestedAt);
    if (!Number.isFinite(startMs)) {
      return null;
    }
    return {
      startIso: latestTurn.requestedAt,
      endIso: null,
      isLive: true,
      durationMs: null,
      elapsedLabel: null,
    };
  }

  // Settled step (completed or error): require an actual turn completion time.
  if (!latestTurn.completedAt) {
    return null;
  }
  if (step.turnId) {
    if (latestTurn.turnId !== step.turnId) {
      return null;
    }
  } else if (isShared) {
    // Shared thread with no pinned turn id on this step: refuse to guess.
    return null;
  }

  const startMs = Date.parse(latestTurn.requestedAt);
  const endMs = Date.parse(latestTurn.completedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  const durationMs = endMs - startMs;
  const elapsedLabel = formatElapsed(latestTurn.requestedAt, latestTurn.completedAt);
  if (!elapsedLabel) {
    return null;
  }

  return {
    startIso: latestTurn.requestedAt,
    endIso: latestTurn.completedAt,
    isLive: false,
    durationMs,
    elapsedLabel,
  };
}

/**
 * Pure static telemetry aggregation derived only from `phases`, `threadById`,
 * `createdAt`, and `updatedAt` (no 1 Hz ticker dependency). Live elapsed timers
 * tick inside leaf components (`StepElapsed` and `RunElapsed`).
 */
export function computeWorkflowRunTelemetry(input: {
  readonly phases: ReadonlyArray<WorkflowTimelinePhase>;
  readonly threadById: ReadonlyMap<Thread["id"], Thread>;
  readonly createdAt: string;
  readonly updatedAt: string;
}): WorkflowRunTelemetry {
  const threadStepCount = new Map<ThreadId, number>();
  const turnIdsByThread = new Map<ThreadId, Set<string>>();

  for (const phase of input.phases) {
    if (phase.state === "skipped") continue;
    for (const step of phase.steps) {
      if (step.state === "skipped" || !step.threadId) continue;
      threadStepCount.set(step.threadId, (threadStepCount.get(step.threadId) ?? 0) + 1);
      if (step.turnId) {
        let turns = turnIdsByThread.get(step.threadId);
        if (!turns) {
          turns = new Set<string>();
          turnIdsByThread.set(step.threadId, turns);
        }
        turns.add(step.turnId);
      }
    }
  }

  const stepTelemetryByKey = new Map<string, StepTelemetry>();
  const countedThreadIds = new Set<string>();
  let completedSteps = 0;
  let activeSteps = 0;
  let errorSteps = 0;
  let totalSteps = 0;
  let totalContextTokens = 0;
  let slowestStep: WorkflowBottleneckSummary | null = null;
  let latestSettledStepEndIso: string | null = null;
  let latestSettledStepEndMs = Number.NEGATIVE_INFINITY;

  for (const phase of input.phases) {
    if (phase.state === "skipped") {
      continue;
    }

    const phaseEntries: Array<{
      readonly step: WorkflowTimelineStep;
      readonly timing: StepTiming | null;
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
      const isSharedThread = step.threadId ? (threadStepCount.get(step.threadId) ?? 0) > 1 : false;
      let otherStepTurnIds: Set<string> | undefined;
      if (isSharedThread && step.threadId) {
        const allTurns = turnIdsByThread.get(step.threadId);
        if (allTurns && allTurns.size > 0) {
          otherStepTurnIds = new Set(allTurns);
          if (step.turnId) {
            otherStepTurnIds.delete(step.turnId);
          }
        }
      }

      const timing = resolveStepTiming(step, thread, {
        isSharedThread,
        ...(otherStepTurnIds ? { otherStepTurnIds } : {}),
      });

      if (timing?.endIso) {
        const endMs = Date.parse(timing.endIso);
        if (Number.isFinite(endMs) && endMs > latestSettledStepEndMs) {
          latestSettledStepEndMs = endMs;
          latestSettledStepEndIso = timing.endIso;
        }
      }

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

      if (
        timing &&
        timing.durationMs !== null &&
        timing.elapsedLabel !== null &&
        (!slowestStep || timing.durationMs > slowestStep.durationMs)
      ) {
        slowestStep = {
          stepKey: step.key,
          label: step.label,
          durationMs: timing.durationMs,
          elapsedLabel: timing.elapsedLabel,
        };
      }

      phaseEntries.push({
        step,
        timing,
        contextTokens,
      });
    }

    // Identify a bottleneck only among parallel steps in phases explicitly marked parallel.
    let bottleneckKey: string | null = null;
    if (phase.parallel === true) {
      const measured = phaseEntries.filter(
        (
          entry,
        ): entry is typeof entry & {
          readonly timing: StepTiming & { readonly durationMs: number };
        } => entry.timing !== null && entry.timing.durationMs !== null,
      );
      if (measured.length >= 2) {
        const sorted = [...measured].sort(
          (left, right) => left.timing.durationMs - right.timing.durationMs,
        );
        const fastest = sorted[0]!;
        const slowest = sorted.at(-1)!;
        const secondSlowest = sorted.at(-2)!;
        if (
          slowest.timing.durationMs >= BOTTLENECK_MIN_DURATION_MS &&
          slowest.timing.durationMs > secondSlowest.timing.durationMs &&
          (fastest.timing.durationMs === 0 ||
            slowest.timing.durationMs >= fastest.timing.durationMs * BOTTLENECK_MIN_RATIO)
        ) {
          bottleneckKey = slowest.step.key;
        }
      }
    }

    for (const entry of phaseEntries) {
      stepTelemetryByKey.set(entry.step.key, {
        stepKey: entry.step.key,
        label: entry.step.label,
        phaseId: phase.id,
        state: entry.step.state,
        startIso: entry.timing?.startIso ?? null,
        endIso: entry.timing?.endIso ?? null,
        isLive: entry.timing?.isLive ?? false,
        durationMs: entry.timing?.durationMs ?? null,
        elapsedLabel: entry.timing?.elapsedLabel ?? null,
        contextTokens: entry.contextTokens,
        isBottleneck: bottleneckKey === entry.step.key,
      });
    }
  }

  // Keep live timing running whenever any step is still active, even if a sibling failed.
  const isRunLive = activeSteps > 0;
  // Once settled, anchor the run's end to the latest step completion time so later
  // metadata updates (such as archiving) do not inflate the elapsed duration.
  const runSettledEndIso = isRunLive ? null : (latestSettledStepEndIso ?? input.updatedAt);
  const totalElapsedLabel =
    !isRunLive && runSettledEndIso ? formatElapsed(input.createdAt, runSettledEndIso) : null;

  return {
    completedSteps,
    activeSteps,
    errorSteps,
    totalSteps,
    totalContextTokens,
    contextThreadCount: countedThreadIds.size,
    runStartIso: input.createdAt,
    runSettledEndIso,
    isRunLive,
    totalElapsedLabel,
    slowestStep,
    stepTelemetryByKey,
  };
}
