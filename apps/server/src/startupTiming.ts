import { Cause, Effect } from "effect";

const isTestRuntime = () => process.env.NODE_ENV === "test" || process.env.VITEST === "true";

export interface ActiveStartupPhase {
  readonly phase: string;
  readonly startedAtMs: number;
}

let nextActivePhaseId = 0;
const activePhases = new Map<number, ActiveStartupPhase>();

/**
 * Returns the most recently started startup phase that is still running, or
 * `null` when none is. Phases nest (for example `orchestration.runtime.start`
 * wraps `orchestration.projection.bootstrap`), so this is the innermost one.
 */
export function getCurrentStartupPhase(): ActiveStartupPhase | null {
  let current: ActiveStartupPhase | null = null;
  for (const phase of activePhases.values()) {
    if (current === null || phase.startedAtMs >= current.startedAtMs) current = phase;
  }
  return current;
}

/** Message for a request that gave up waiting for startup to finish. */
export function formatStillStartingMessage(input: {
  readonly phase: string | null;
  readonly elapsedMs: number;
}): string {
  const elapsedSeconds = Math.max(0, Math.round(input.elapsedMs / 1000));
  const detail =
    input.phase === null
      ? `${elapsedSeconds}s elapsed`
      : `${input.phase}, ${elapsedSeconds}s elapsed`;
  return `Server is still starting (${detail}). Try again shortly.`;
}

const trackActivePhase = <A, E, R>(
  phase: string,
  startedAtMs: number,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const id = nextActivePhaseId++;
    activePhases.set(id, { phase, startedAtMs });
    return effect.pipe(Effect.ensuring(Effect.sync(() => activePhases.delete(id))));
  });

export function withStartupPhaseTiming<A, E, R>(
  phase: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (isTestRuntime()) {
    return Effect.suspend(() => trackActivePhase(phase, Date.now(), effect));
  }

  return Effect.gen(function* () {
    const startedAtMs = Date.now();
    yield* Effect.logInfo("startup phase started", { phase });

    return yield* trackActivePhase(phase, startedAtMs, effect).pipe(
      Effect.tap(() =>
        Effect.logInfo("startup phase completed", {
          phase,
          durationMs: Date.now() - startedAtMs,
        }),
      ),
      Effect.tapCause((cause) =>
        Effect.logWarning("startup phase failed", {
          phase,
          durationMs: Date.now() - startedAtMs,
          causePretty: Cause.pretty(cause),
          cause,
        }),
      ),
      Effect.withSpan(`server.startup.${phase}`, {
        attributes: {
          "startup.phase": phase,
        },
      }),
    );
  });
}
