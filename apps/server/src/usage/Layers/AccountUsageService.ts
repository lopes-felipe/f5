import type { AccountUsageSection, UsageAccount } from "@t3tools/contracts";
import { Cache, Cause, Clock, Deferred, Effect, Ref } from "effect";
import { accountUsageErrorCode } from "../accountUsageErrors.ts";

import { ACCOUNT_ATTEMPT_TTL_MS, type AccountUsageCapability } from "../accountUsage.ts";
export type { AccountUsageCapability } from "../accountUsage.ts";
export function emptyAccountSection(kind: AccountUsageSection["kind"]): AccountUsageSection {
  return { kind, outcome: "unavailable", lastAttemptAt: null, snapshot: null, errorCode: null };
}

/** Each capability belongs to its provider scope; request cancellation cannot cancel its jobs. */
export const makeAccountUsageCapability = <E>(
  initial: UsageAccount,
  read: Effect.Effect<ReadonlyArray<AccountUsageSection>, E>,
  options: { readonly readerOwnsTimeout?: boolean } = {},
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const state = yield* Ref.make(initial);
    // TTL starts at completion, including failure. Forced refresh bypasses it.
    let inFlight: Deferred.Deferred<void> | undefined;
    const lastJobFresh = yield* Ref.make(false);
    const lastCompleted = yield* Ref.make<number | null>(null);
    const attempts = yield* Cache.make({
      capacity: 4,
      timeToLive: ACCOUNT_ATTEMPT_TTL_MS,
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
          const scheduled = yield* Ref.modify(state, (current) => {
            if (
              current.refreshState !== "idle" ||
              (previous !== null &&
                now - previous < (mode === "force" ? 5_000 : ACCOUNT_ATTEMPT_TTL_MS))
            )
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
              jobFresh = sections.some(
                (section) => section.outcome === "available" && section.snapshot !== null,
              );
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
    const refreshAccount = (permits: Parameters<AccountUsageCapability["refresh"]>[1]) =>
      Effect.gen(function* () {
        const previousCompletion = yield* Ref.get(lastCompleted);
        yield* refresh("force", permits);
        const pending = inFlight;
        if (pending) yield* Deferred.await(pending);
        const snapshot = yield* Ref.get(state);
        const completed = yield* Ref.get(lastCompleted);
        const joined = pending !== undefined || completed !== previousCompletion;
        const fresh = joined && (yield* Ref.get(lastJobFresh));
        return {
          snapshot,
          fresh,
          ...(!joined && completed !== null
            ? { nextAllowedAt: new Date(completed + 5000).toISOString() }
            : {}),
        };
      });
    return {
      getSnapshot: Ref.get(state),
      refresh,
      refreshAccount,
    } satisfies AccountUsageCapability;
  });
