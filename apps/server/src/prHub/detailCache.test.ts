import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import type { PrHubDetailResult } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { GitHubCredentialScope } from "../git/githubApi.ts";
import { readPrDetailCache, type CachedPrDetailRead } from "./detailCache.ts";

it.effect("isolates cache reads even when an old account finishes after a cache clear", () =>
  Effect.gen(function* () {
    const cache = new Map<
      string,
      CachedPrDetailRead<{ stale: boolean; refreshedAt: string; body: string }>
    >();
    const account = (generation: string) => ({
      host: "github.com",
      login: "same-login",
      viewerId: generation === "old" ? 1 : 2,
      generation,
    });
    const read = (generation: string, body: string) =>
      readPrDetailCache({
        cache,
        key: "same-pr",
        mode: "if_stale",
        fetch: Effect.succeed({ stale: false, refreshedAt: new Date().toISOString(), body }),
      }).pipe(Effect.provideService(GitHubCredentialScope, account(generation)));
    yield* read("old", "old account data");
    cache.clear();
    yield* read("new", "new account data");
    // The previous request finishes late and stores under its own generation.
    yield* read("old", "late old account data");
    assert.equal((yield* read("new", "unexpected fetch")).body, "new account data");
    assert.equal(cache.size, 2);
  }),
);

it.effect("bounds cached bytes and refuses oversized individual values", () =>
  Effect.gen(function* () {
    const cache = new Map<
      string,
      CachedPrDetailRead<{ stale: boolean; refreshedAt: string; body: string }>
    >();
    const fetch = (key: string, body: string) =>
      readPrDetailCache({
        cache,
        key,
        mode: "force",
        fetch: Effect.succeed({ stale: false, refreshedAt: new Date().toISOString(), body }),
      });
    const body = "x".repeat(7 * 1024 * 1024);
    for (let i = 0; i < 7; i++) yield* fetch(String(i), body);
    assert.isAtMost(
      [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0),
      40 * 1024 * 1024,
    );
    assert.equal(cache.has("unverified:0"), false);
    yield* fetch("oversized", "x".repeat(8 * 1024 * 1024));
    assert.equal(cache.has("unverified:oversized"), false);
  }),
);

it.effect("retains the rate-limit reason and reset time when serving a cached detail", () =>
  Effect.gen(function* () {
    type Value = Pick<PrHubDetailResult, "stale" | "refreshedAt" | "rateLimit" | "readErrorKind">;
    const cache = new Map<string, CachedPrDetailRead<Value>>();
    const value: Value = { stale: false, refreshedAt: "2026-10-19T12:00:00.000Z" };
    yield* readPrDetailCache({ cache, key: "pr", mode: "force", fetch: Effect.succeed(value) });
    const resetAt = "2026-10-19T12:05:00.000Z";
    const result = yield* readPrDetailCache({
      cache,
      key: "pr",
      mode: "force",
      fetch: Effect.fail(
        new SourceControlProviderError({
          provider: "github",
          operation: "detail",
          kind: "rate_limited",
          detail: "Rate limited",
          rateLimit: { resetAt },
        }),
      ),
    });
    assert.equal(result.stale, true);
    assert.equal(result.readErrorKind, "rate_limited");
    assert.equal(result.rateLimit?.resetAt, resetAt);
  }),
);
