import { Effect, Exit, Semaphore } from "effect";
import type { PrHubChangeBreakdown } from "@t3tools/contracts";
import type { SourceControlProviderError } from "../sourceControl/SourceControlProvider";
import { PR_DETAIL_CACHE_TTL_MS } from "./detailCache";

type Read = Effect.Effect<PrHubChangeBreakdown | null, SourceControlProviderError>;
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
          const entry = { read: fetch, expires: Infinity };
          entry.read = yield* Effect.cached(
            fetch.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isSuccess(exit)) entry.expires = Date.now() + PR_DETAIL_CACHE_TTL_MS;
                  else if (entries.get(key) === entry) entries.delete(key);
                }),
              ),
            ),
          );
          entries.delete(key);
          entries.set(key, entry);
          while (entries.size > 128) entries.delete(entries.keys().next().value!);
          return entry.read;
        }),
      )
      .pipe(Effect.flatMap((read) => read));
});
