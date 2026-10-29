import type { AccountUsageSection, UsageAccount } from "@t3tools/contracts";
import { Cache, Cause, Clock, Deferred, Duration, Effect, Exit, Ref } from "effect";
import { accountUsageErrorCode } from "../accountUsageErrors.ts";

import { ACCOUNT_ATTEMPT_TTL_MS, type AccountUsageCapability } from "../accountUsage.ts";
export type { AccountUsageCapability } from "../accountUsage.ts";
export function emptyAccountSection(kind: AccountUsageSection["kind"]): AccountUsageSection {
  return { kind, outcome: "unavailable", lastAttemptAt: null, snapshot: null, errorCode: null };
}

/**
 * Each capability belongs to its provider scope; request cancellation cannot
 * cancel its jobs. `identity` is a hash of the account configuration, so
 * persisted history never stores raw secrets.
 */
export const makeAccountUsageCapability = <E>(
  initial: UsageAccount,
  read: Effect.Effect<ReadonlyArray<AccountUsageSection>, E>,
  options: {
    readonly identity: string;
    readonly readerOwnsTimeout?: boolean;
    /** Only an available read holds the attempt TTL; failed reads retry on the next refresh. */
    readonly retryFailedReads?: boolean;
  },
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const state = yield* Ref.make(initial);
    // TTL starts at completion, including failure unless `retryFailedReads`. Forced refresh bypasses it.
    let inFlight: Deferred.Deferred<void> | undefined;
    const lastJobFresh = yield* Ref.make(false);
    const lastCompleted = yield* Ref.make<number | null>(null);
    const isFresh = (sections: ReadonlyArray<AccountUsageSection>) =>
      sections.some((section) => section.outcome === "available" && section.snapshot !== null);
    const attempts = yield* Cache.makeWith({
      capacity: 4,
      timeToLive: (exit) =>
        options.retryFailedReads && !(Exit.isSuccess(exit) && isFresh(exit.value))
          ? Duration.zero
          : ACCOUNT_ATTEMPT_TTL_MS,
      lookup: () =>
        (options.readerOwnsTimeout ? read : read.pipe(Effect.timeout("8 seconds"))).pipe(
          // Readers return section failures independently. Only a connection-level
          // failure (or defect) here applies to every section. Never swallow retirement.
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.gen(function* () {
                  const at = new Date(yield* Clock.currentTimeMillis).toISOString();
                  const errorCode = accountUsageErrorCode(Cause.squash(cause));
                  return initial.sections.map((section) => ({
                    ...section,
                    outcome:
                      errorCode === "unsupported"
                        ? ("unsupported" as const)
                        : ("unavailable" as const),
                    lastAttemptAt: at,
                    errorCode,
                  }));
                }),
          ),
          Effect.ensuring(
            Clock.currentTimeMillis.pipe(Effect.flatMap((at) => Ref.set(lastCompleted, at))),
          ),
        ),
    });
    const refresh: AccountUsageCapability["refresh"] = (mode = "if-stale", permits) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!initial.enabled || mode === "none") return;
          const now = yield* Clock.currentTimeMillis;
          const previous = yield* Ref.get(lastCompleted);
          const holdMs =
            mode === "force"
              ? 5_000
              : options.retryFailedReads && !(yield* Ref.get(lastJobFresh))
                ? 0
                : ACCOUNT_ATTEMPT_TTL_MS;
          const scheduled = yield* Ref.modify(state, (current) => {
            if (current.refreshState !== "idle" || (previous !== null && now - previous < holdMs))
              return [false, current] as const;
            return [true, { ...current, refreshState: "queued" as const }] as const;
          });
          if (!scheduled) return;
          const completion = yield* Deferred.make<void>();
          inFlight = completion;
          let jobFresh = false;
          const job = permits.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                refreshState: "refreshing" as const,
              }));
              if (mode === "force") yield* Cache.invalidate(attempts, initial.key);
              const sections = yield* Cache.get(attempts, initial.key);
              jobFresh = isFresh(sections);
              yield* Ref.update(state, (current) => ({
                ...current,
                sections: sections.map((section) => {
                  const prior = current.sections.find((entry) => entry.kind === section.kind);
                  // A successful empty snapshot replaces old data; only failed reads retain it.
                  return section.outcome === "available"
                    ? section
                    : ({ ...section, snapshot: prior?.snapshot ?? null } as AccountUsageSection);
                }),
              }));
            }),
          );
          yield* job.pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.update(state, (current) => ({
                  ...current,
                  refreshState: "idle" as const,
                }));
                yield* Ref.set(lastJobFresh, jobFresh);
                inFlight = undefined;
                yield* Deferred.succeed(completion, undefined);
              }),
            ),
            Effect.forkIn(scope),
          );
        }),
      );
    const refreshAccount: NonNullable<AccountUsageCapability["refreshAccount"]> = (
      permits,
      mode = "force",
    ) =>
      Effect.gen(function* () {
        const previousCompletion = yield* Ref.get(lastCompleted);
        yield* refresh(mode, permits);
        const pending = inFlight;
        if (pending) yield* Deferred.await(pending);
        const snapshot = yield* Ref.get(state);
        const completed = yield* Ref.get(lastCompleted);
        const joined = pending !== undefined || completed !== previousCompletion;
        const fresh = joined && (yield* Ref.get(lastJobFresh));
        return {
          snapshot,
          fresh,
          ...(mode === "force" && !joined && completed !== null
            ? { nextAllowedAt: new Date(completed + 5000).toISOString() }
            : {}),
        };
      });
    return {
      identity: options.identity,
      getSnapshot: Ref.get(state),
      refresh,
      refreshAccount,
      invalidate: Cache.invalidateAll(attempts).pipe(
        Effect.andThen(Ref.set(lastJobFresh, false)),
        Effect.andThen(Ref.set(lastCompleted, null)),
      ),
    } satisfies AccountUsageCapability;
  });
