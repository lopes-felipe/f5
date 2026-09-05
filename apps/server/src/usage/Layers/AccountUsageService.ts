import type { AccountUsageSection, UsageAccount } from "@t3tools/contracts";
import { Cache, Cause, Clock, Effect, Ref } from "effect";
import { accountUsageErrorCode } from "../accountUsageErrors.ts";

import {
  ACCOUNT_ATTEMPT_TTL_MS,
  ACCOUNT_FORCE_COOLDOWN_MS,
  type AccountUsageCapability,
} from "../accountUsage.ts";
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
    // Cache TTL starts at completion; force cooldown starts only on a real miss.
    // A cache hit must never postpone the next eligible attempt.
    const lastStarted = yield* Ref.make<number | null>(null);
    const lastCompleted = yield* Ref.make<number | null>(null);
    const attempts = yield* Cache.make({
      capacity: 4,
      timeToLive: ACCOUNT_ATTEMPT_TTL_MS,
      lookup: () =>
        Effect.gen(function* () {
          yield* Ref.set(lastStarted, yield* Clock.currentTimeMillis);
          return yield* options.readerOwnsTimeout ? read : read.pipe(Effect.timeout("8 seconds"));
        }).pipe(
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
          const previous = yield* Ref.get(mode === "force" ? lastStarted : lastCompleted);
          const scheduled = yield* Ref.modify(state, (current) => {
            if (
              current.refreshState !== "idle" ||
              (previous !== null &&
                now - previous <
                  (mode === "force" ? ACCOUNT_FORCE_COOLDOWN_MS : ACCOUNT_ATTEMPT_TTL_MS))
            )
              return [false, current] as const;
            return [true, { ...current, refreshState: "queued" as const }] as const;
          });
          if (!scheduled) return;
          const job = permits.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                refreshState: "refreshing" as const,
              }));
              if (mode === "force") yield* Cache.invalidate(attempts, initial.key);
              const sections = yield* Cache.get(attempts, initial.key);
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
              Ref.update(state, (current) => ({ ...current, refreshState: "idle" as const })),
            ),
            Effect.forkIn(scope),
          );
        }),
      );
    return { getSnapshot: Ref.get(state), refresh } satisfies AccountUsageCapability;
  });
