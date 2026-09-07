import { Effect, Option } from "effect";
import { GitHubCredentialScope } from "../git/githubApi.ts";
import type { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

export const PR_DETAIL_CACHE_TTL_MS = 30_000;
const PR_DETAIL_CACHE_CAPACITY = 128;

export interface CachedPrDetailRead<A> {
  readonly value: A;
  readonly storedAt: number;
  readonly bytes: number;
}

interface PrDetailReadMetadata {
  readonly stale: boolean;
  readonly refreshedAt: string;
  readonly warning?: string | undefined;
}

function cacheSet<A>(cache: Map<string, CachedPrDetailRead<A>>, key: string, value: A): void {
  cache.delete(key);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > 8 * 1024 * 1024) return;
  cache.set(key, { value, storedAt: Date.now(), bytes });
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  // Three caches share at most 120 MiB, leaving headroom under the 128 MiB budget.
  while (cache.size > PR_DETAIL_CACHE_CAPACITY || total > 40 * 1024 * 1024) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    total -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

function isRetainableDetailFailure(error: SourceControlProviderError): boolean {
  return error.kind === "network" || error.kind === "timeout" || error.kind === "rate_limited";
}

export function readPrDetailCache<A extends PrDetailReadMetadata>(input: {
  readonly cache: Map<string, CachedPrDetailRead<A>>;
  readonly key: string;
  readonly mode: "if_stale" | "force";
  readonly fetch: Effect.Effect<A, SourceControlProviderError>;
}): Effect.Effect<A, SourceControlProviderError> {
  return Effect.gen(function* () {
    const capture = yield* Effect.serviceOption(GitHubCredentialScope);
    const generation = Option.isSome(capture) ? capture.value.generation : "unverified";
    const key = `${generation}:${input.key}`;
    const cached = input.cache.get(key);
    if (
      input.mode === "if_stale" &&
      cached &&
      Date.now() - cached.storedAt < PR_DETAIL_CACHE_TTL_MS
    ) {
      input.cache.delete(key);
      input.cache.set(key, cached);
      return cached.value;
    }
    return yield* input.fetch.pipe(
      Effect.tap((value) => Effect.sync(() => cacheSet(input.cache, key, value))),
      Effect.catch((error) =>
        cached && isRetainableDetailFailure(error)
          ? Effect.succeed({
              ...cached.value,
              stale: true,
              warning: error.detail,
            })
          : Effect.fail(error),
      ),
    );
  });
}
