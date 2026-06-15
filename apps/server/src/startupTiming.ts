import { Cause, Effect } from "effect";

const isTestRuntime = () => process.env.NODE_ENV === "test" || process.env.VITEST === "true";

export function withStartupPhaseTiming<A, E, R>(
  phase: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (isTestRuntime()) {
    return effect;
  }

  return Effect.gen(function* () {
    const startedAtMs = Date.now();
    yield* Effect.logInfo("startup phase started", { phase });

    return yield* effect.pipe(
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
