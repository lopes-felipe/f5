import type { ClaudeUsageAnalysis, UsageAccount } from "@t3tools/contracts";
import { Cause, Deferred, Effect, Exit, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { AccountUsageCapability } from "../../usage/accountUsage.ts";
import { AccountUsageReadError, accountUsageErrorCode } from "../../usage/accountUsageErrors.ts";

/**
 * Analyze usage for one Claude instance. Runs are single-flight (a second caller joins the
 * running scan), take one of the shared account-probe permits before their 60 s budget
 * starts, and are forked in the instance scope so removing the instance cancels them. The
 * latest result lives in memory only.
 */
export const makeClaudeUsageAnalyzer = (
  run: Effect.Effect<ClaudeUsageAnalysis, AccountUsageReadError>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const latest = yield* Ref.make<ClaudeUsageAnalysis | undefined>(undefined);
    const lock = yield* Semaphore.make(1);
    let inFlight: Deferred.Deferred<ClaudeUsageAnalysis, AccountUsageReadError> | undefined;

    const analyze = (permits: Semaphore.Semaphore) =>
      Effect.gen(function* () {
        const pending = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (inFlight) return inFlight;
            const started = yield* Deferred.make<ClaudeUsageAnalysis, AccountUsageReadError>();
            // Recorded before the fork, so a fast scan cannot finish before it is visible.
            inFlight = started;
            yield* permits
              .withPermits(1)(run)
              .pipe(
                Effect.tap((analysis) => Ref.set(latest, analysis)),
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (inFlight === started) inFlight = undefined;
                  }).pipe(Effect.andThen(Deferred.done(started, exit))),
                ),
                Effect.forkIn(scope),
              );
            return started;
          }),
        );
        const exit = yield* Effect.exit(Deferred.await(pending));
        if (Exit.isSuccess(exit)) return exit.value;
        // Instance removal interrupts the scan; report it like a vanished process.
        if (Cause.hasInterrupts(exit.cause))
          return yield* Effect.fail(new AccountUsageReadError("process-unavailable"));
        const error = Cause.squash(exit.cause);
        return yield* Effect.fail(
          error instanceof AccountUsageReadError
            ? error
            : new AccountUsageReadError(accountUsageErrorCode(error)),
        );
      });

    /** Adds the latest analysis to every account snapshot this capability reports. */
    const withAnalysis = (capability: AccountUsageCapability): AccountUsageCapability => {
      const merge = (account: UsageAccount) =>
        Ref.get(latest).pipe(
          Effect.map(
            (analysis): UsageAccount =>
              analysis ? { ...account, usageAnalysis: analysis } : account,
          ),
        );
      return {
        ...capability,
        getSnapshot: capability.getSnapshot.pipe(Effect.flatMap(merge)),
        ...(capability.refreshAccount
          ? {
              refreshAccount: (permits, mode) =>
                capability.refreshAccount!(permits, mode).pipe(
                  Effect.flatMap((result) =>
                    merge(result.snapshot).pipe(
                      Effect.map((snapshot) => ({ ...result, snapshot })),
                    ),
                  ),
                ),
            }
          : {}),
      };
    };

    return { analyze, latest: Ref.get(latest), withAnalysis };
  });
