import type { AccountUsageSection, UsageAccount, UsageGetAccountsInput } from "@t3tools/contracts";
import { Cache, Clock, Effect, Ref } from "effect";
import type * as Semaphore from "effect/Semaphore";
import { accountUsageErrorCode } from "../accountUsageErrors.ts";

export const ACCOUNT_ATTEMPT_TTL_MS = 5 * 60_000;
export const ACCOUNT_FORCE_COOLDOWN_MS = 30_000;
export interface AccountUsageCapability {
  readonly getSnapshot: Effect.Effect<UsageAccount>;
  readonly refresh: (
    mode: UsageGetAccountsInput["refresh"],
    permits: Semaphore.Semaphore,
  ) => Effect.Effect<void>;
}
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
    const lastScheduled = yield* Ref.make<number | null>(null);
    const attempts = yield* Cache.make({
      capacity: 4,
      timeToLive: ACCOUNT_ATTEMPT_TTL_MS,
      lookup: () => read,
    });
    const refresh: AccountUsageCapability["refresh"] = (mode = "if-stale", permits) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!initial.enabled || mode === "none") return;
          const now = yield* Clock.currentTimeMillis;
          const previous = yield* Ref.get(lastScheduled);
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
          yield* Ref.set(lastScheduled, now);
          const job = permits.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                refreshState: "refreshing" as const,
              }));
              yield* Ref.set(lastScheduled, yield* Clock.currentTimeMillis);
              if (mode === "force") yield* Cache.invalidate(attempts, initial.key);
              const sections = yield* Cache.get(attempts, initial.key).pipe(
                // Queue time is intentionally outside the eight-second probe budget.
                (effect) =>
                  options.readerOwnsTimeout ? effect : effect.pipe(Effect.timeout("8 seconds")),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const at = new Date(yield* Clock.currentTimeMillis).toISOString();
                    const errorCode = accountUsageErrorCode(error);
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
              Ref.update(state, (current) => ({ ...current, refreshState: "idle" as const })),
            ),
            Effect.forkIn(scope),
          );
        }),
      );
    return { getSnapshot: Ref.get(state), refresh } satisfies AccountUsageCapability;
  });
