import type { UsageAccount } from "@t3tools/contracts";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";
import { Cause, Clock, Duration, Effect, Exit } from "effect";
import type * as Semaphore from "effect/Semaphore";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { AccountHistoryRecorder } from "./accountHistory.ts";

export const QUOTA_SAMPLER_INITIAL_DELAY = Duration.minutes(1);
/** Scheduler granularity; each account probes only when it is due. */
export const QUOTA_SAMPLER_INTERVAL = Duration.minutes(10);
export const QUOTA_SAMPLER_PROBE_TIMEOUT = Duration.minutes(2);
export const QUOTA_SAMPLE_RETENTION_MS = 35 * 24 * 60 * 60_000;
const BACKOFF_BASE_MINUTES = 10;
const BACKOFF_CAP_MINUTES = 120;
const SHORT_WINDOW_HORIZON_MS = 6 * 60 * 60_000;
const SHORT_WINDOW_INTERVAL_MINUTES = 10;
const LONG_WINDOW_INTERVAL_MINUTES = 60;

interface ScheduleState {
  failures: number;
  nextDueAt: number;
}

/**
 * Minutes until the next sample after a success: windows resetting within six
 * hours (e.g. 5-hour limits) need fine-grained history for forecasts; weekly
 * or unknown windows move slowly and are sampled hourly.
 */
export function quotaSamplerSuccessMinutes(account: UsageAccount, now: number): number {
  const soonestReset = Math.min(
    ...account.sections.flatMap((section) =>
      quotaWindowsFromSection(section).flatMap((window) => {
        const resetsAt = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
        return Number.isFinite(resetsAt) && resetsAt > now ? [resetsAt] : [];
      }),
    ),
  );
  return soonestReset - now <= SHORT_WINDOW_HORIZON_MS
    ? SHORT_WINDOW_INTERVAL_MINUTES
    : LONG_WINDOW_INTERVAL_MINUTES;
}

/** Minutes to wait after `failures` consecutive probes without an available section. */
export function quotaSamplerBackoffMinutes(failures: number): number {
  return failures <= 0
    ? 0
    : Math.min(BACKOFF_CAP_MINUTES, BACKOFF_BASE_MINUTES * 2 ** (failures - 1));
}

/** Logs non-interrupt causes and re-raises interrupts so scope closure still stops the loop. */
const isolate =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning(message, Cause.pretty(cause)),
      ),
    );

/**
 * Samples quota windows in the background so history survives without the
 * dashboard open. Instances are probed serially, each only when due: after a
 * success per `quotaSamplerSuccessMinutes`, after any failure (including
 * authentication-required and unsupported, so an external login or upgrade
 * is picked up) with backoff capped at two hours. The setting gate stops all
 * probing; age-based pruning still runs.
 */
export function makeQuotaSampler(input: {
  readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
  /** Account keys whose snapshots stay even when old (current and shadow accounts). */
  readonly listAccountKeys: Effect.Effect<ReadonlyArray<string>>;
  /** Whether background sampling is enabled; read every tick. */
  readonly enabled: Effect.Effect<boolean>;
  readonly permits: Semaphore.Semaphore;
  readonly recorder: AccountHistoryRecorder;
  readonly prune: (input: {
    readonly before: string;
    readonly keepAccountKeys: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}) {
  const schedule = new Map<string, ScheduleState>();

  const sampleInstance = (instance: ProviderInstance) =>
    Effect.gen(function* () {
      const capability = instance.accountUsage;
      if (!instance.enabled || !capability?.refreshAccount) return;
      const account = yield* capability.getSnapshot;
      if (account.refreshState !== "idle") return;
      const now = yield* Clock.currentTimeMillis;
      const state = schedule.get(account.key);
      if (state && now < state.nextDueAt) return;
      const result = yield* Effect.exit(
        capability
          .refreshAccount(input.permits, "if-stale")
          .pipe(Effect.timeout(QUOTA_SAMPLER_PROBE_TIMEOUT)),
      );
      if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
        return yield* Effect.failCause(result.cause);
      const succeeded =
        Exit.isSuccess(result) &&
        result.value.snapshot.sections.some((section) => section.outcome === "available");
      if (Exit.isSuccess(result))
        yield* input.recorder.observe(result.value.snapshot, capability.identity);
      const failures = succeeded ? 0 : (state?.failures ?? 0) + 1;
      const waitMinutes =
        succeeded && Exit.isSuccess(result)
          ? quotaSamplerSuccessMinutes(result.value.snapshot, now)
          : quotaSamplerBackoffMinutes(failures);
      schedule.set(account.key, { failures, nextDueAt: now + waitMinutes * 60_000 });
      if (Exit.isFailure(result))
        yield* Effect.logWarning(
          "Background quota sample failed",
          account.key,
          Cause.pretty(result.cause),
        );
    });

  const tick = Effect.gen(function* () {
    if (yield* input.enabled) {
      const instances = yield* input.listInstances;
      for (const instance of instances)
        yield* sampleInstance(instance).pipe(isolate("Background quota sampling failed"));
    } else {
      // Re-enabling samples every account on the next tick.
      schedule.clear();
    }
    const now = yield* Clock.currentTimeMillis;
    const keepAccountKeys = yield* input.listAccountKeys;
    yield* input
      .prune({
        before: new Date(now - QUOTA_SAMPLE_RETENTION_MS).toISOString(),
        keepAccountKeys,
      })
      .pipe(isolate("Quota history pruning failed"));
  }).pipe(isolate("Background quota sampling tick failed"));

  const run = Effect.sleep(QUOTA_SAMPLER_INITIAL_DELAY).pipe(
    Effect.andThen(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(QUOTA_SAMPLER_INTERVAL))))),
  );

  return { tick, run };
}
