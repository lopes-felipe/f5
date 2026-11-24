import { Deferred, Effect, Exit, Semaphore } from "effect";
import type { PrHubChangeBreakdownResult } from "@t3tools/contracts";
import type { SourceControlProviderError } from "../sourceControl/SourceControlProvider";
import { PR_DETAIL_CACHE_TTL_MS } from "./detailCache";

type Read = Effect.Effect<PrHubChangeBreakdownResult | null, SourceControlProviderError>;
/** Account/comparison-scoped, bounded cache; concurrent readers share one fetch. */
export const makeChangeBreakdownCache = Effect.gen(function* () {
  const gate = yield* Semaphore.make(1);
  const entries = new Map<string, { read: Read; expires: number }>();
  return (key: string, fetch: Read): Read =>
    gate
      .withPermits(1)(
        Effect.gen(function* () {
          const previous = entries.get(key);
          if (previous && previous.expires > Date.now()) return previous.read;
          const result = yield* Deferred.make<
            PrHubChangeBreakdownResult | null,
            SourceControlProviderError
          >();
          const entry = { read: Deferred.await(result), expires: Infinity };
          entries.delete(key);
          entries.set(key, entry);
          while (entries.size > 128) entries.delete(entries.keys().next().value!);
          yield* fetch.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) entry.expires = Date.now() + PR_DETAIL_CACHE_TTL_MS;
                else if (entries.get(key) === entry) entries.delete(key);
              }),
            ),
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(result, exit)),
            // A reader leaving a view must not interrupt other readers' fetch.
            Effect.forkDetach,
          );
          return entry.read;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.flatMap((read) => read));
});
