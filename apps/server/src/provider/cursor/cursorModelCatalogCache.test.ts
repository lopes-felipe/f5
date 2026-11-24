import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { CursorModelCatalogResult } from "../Layers/CursorProvider.ts";
import {
  CURSOR_MODEL_CATALOG_RETRY_MS,
  CURSOR_MODEL_CATALOG_TTL_MS,
  makeCursorModelCatalogCache,
  seedCursorModelCatalog,
  type CachedCursorModelCatalog,
} from "./cursorModelCatalogCache.ts";

const model = (slug: string): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
});

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    enabled: true,
    status: "ready",
    version: "2026.11.22-e9042b2",
    auth: { status: "authenticated", email: "me@example.com" },
    models: [],
    ...overrides,
  }) as ServerProvider;

const slugs = (provider: Pick<ServerProvider, "models">) =>
  provider.models.map((entry) => entry.slug);

function makeHarness(results: Array<CursorModelCatalogResult>, seed?: CachedCursorModelCatalog) {
  let clock = 0;
  let fetches = 0;
  const published: Array<ServerProvider> = [];
  const cache = Effect.runSync(
    makeCursorModelCatalogCache({
      settings: { customModels: ["mine"] },
      fetch: Effect.sync(() => {
        fetches += 1;
        return results.shift() ?? { _tag: "failed", detail: "no more results" };
      }),
      now: () => clock,
      seed,
    }),
  );
  const enrich = (provider: ServerProvider) =>
    Effect.runPromise(
      cache.enrich({
        snapshot: provider,
        publishSnapshot: (next) => Effect.sync(() => void published.push(next)),
      }),
    );
  return {
    cache,
    enrich,
    published,
    fetches: () => fetches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("makeCursorModelCatalogCache", () => {
  it("publishes a fetched catalog and keeps it on later status snapshots", async () => {
    const harness = makeHarness([{ _tag: "ok", models: [model("gemini-4-neon")] }]);
    await harness.enrich(snapshot());
    expect(harness.published.map(slugs)).toEqual([["gemini-4-neon", "mine"]]);

    // Within the hour a refresh reuses the catalog and fetches nothing.
    harness.advance(CURSOR_MODEL_CATALOG_TTL_MS - 1);
    expect(slugs(Effect.runSync(harness.cache.applyCached(snapshot())))).toEqual([
      "gemini-4-neon",
      "mine",
    ]);
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(1);
  });

  it("refetches after an hour or when the CLI version or account changes", async () => {
    const harness = makeHarness([
      { _tag: "ok", models: [model("a")] },
      { _tag: "ok", models: [model("b")] },
      { _tag: "ok", models: [model("c")] },
      { _tag: "ok", models: [model("d")] },
    ]);
    await harness.enrich(snapshot());
    harness.advance(CURSOR_MODEL_CATALOG_TTL_MS);
    await harness.enrich(snapshot());
    await harness.enrich(snapshot({ version: "2026.12.01-0000000" }));
    await harness.enrich(
      snapshot({
        version: "2026.12.01-0000000",
        auth: { status: "authenticated", email: "x@y.z" },
      }),
    );
    expect(harness.fetches()).toBe(4);
    // A catalog never applies to another account's snapshot.
    expect(slugs(Effect.runSync(harness.cache.applyCached(snapshot())))).toEqual([]);
  });

  it("does not ask a CLI without the catalog request again until its version changes", async () => {
    const harness = makeHarness([{ _tag: "unsupported" }, { _tag: "unsupported" }]);
    await harness.enrich(snapshot());
    harness.advance(CURSOR_MODEL_CATALOG_TTL_MS * 5);
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(1);
    await harness.enrich(snapshot({ version: "2026.12.01-0000000" }));
    expect(harness.fetches()).toBe(2);
    // Such a CLI keeps the built-in list F5 offered before the catalog.
    expect(harness.published.map(slugs).at(-1)).toEqual([
      "auto",
      "composer-2",
      "composer-1.5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-5",
      "mine",
    ]);
  });

  it("keeps the shown catalog when a refetch fails and retries with a growing delay", async () => {
    const harness = makeHarness([
      { _tag: "ok", models: [model("a")] },
      { _tag: "failed", detail: "timed out" },
      { _tag: "failed", detail: "Authorization: Bearer secret-token-123" },
      { _tag: "ok", models: [model("b")] },
    ]);
    await harness.enrich(snapshot());
    harness.advance(CURSOR_MODEL_CATALOG_TTL_MS);
    await harness.enrich(snapshot());
    expect(slugs(Effect.runSync(harness.cache.applyCached(snapshot())))).toEqual(["a", "mine"]);
    // Not before the first retry delay, and twice as long after the second failure.
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(2);
    harness.advance(CURSOR_MODEL_CATALOG_RETRY_MS);
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(3);
    harness.advance(CURSOR_MODEL_CATALOG_RETRY_MS);
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(3);
    harness.advance(CURSOR_MODEL_CATALOG_RETRY_MS);
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(4);
    expect(harness.published.map(slugs).at(-1)).toEqual(["b", "mine"]);
  });

  it("keeps the last catalog on snapshots that cannot confirm the account", async () => {
    const harness = makeHarness([{ _tag: "ok", models: [model("a")] }]);
    await harness.enrich(snapshot());
    const apply = (provider: ServerProvider) =>
      slugs(Effect.runSync(harness.cache.applyCached(provider)));
    // A timed-out `agent about` and a CLI update still being fetched keep it.
    expect(apply(snapshot({ status: "error", auth: { status: "unknown" } }))).toEqual([
      "a",
      "mine",
    ]);
    expect(apply(snapshot({ version: "2026.12.01-0000000" }))).toEqual(["a", "mine"]);
    // Signing out, another account or disabling the provider drop it.
    expect(apply(snapshot({ auth: { status: "unauthenticated" } }))).toEqual([]);
    expect(apply(snapshot({ auth: { status: "authenticated", email: "x@y.z" } }))).toEqual([]);
    expect(apply(snapshot({ enabled: false }))).toEqual([]);
  });

  it("shows the catalog the previous process published until a fresh one arrives", async () => {
    const persisted = snapshot({
      models: [model("auto"), model("gemini-4-neon"), { ...model("mine"), isCustom: true }],
    });
    const seed = seedCursorModelCatalog(persisted);
    expect(seedCursorModelCatalog(snapshot({ models: [model("auto")] }))).toBeUndefined();
    const harness = makeHarness([{ _tag: "ok", models: [model("fresh")] }], seed);
    expect(slugs(Effect.runSync(harness.cache.applyCached(snapshot())))).toEqual([
      "auto",
      "gemini-4-neon",
      "mine",
    ]);
    // The seed counts as stale, so the first confirmed status refetches it.
    await harness.enrich(snapshot());
    expect(harness.fetches()).toBe(1);
    expect(harness.published.map(slugs)).toEqual([["fresh", "mine"]]);
  });

  it("never fetches for a signed-out, disabled or failing provider", async () => {
    const harness = makeHarness([{ _tag: "ok", models: [model("a")] }]);
    await harness.enrich(snapshot({ auth: { status: "unauthenticated" } }));
    await harness.enrich(snapshot({ enabled: false }));
    await harness.enrich(snapshot({ status: "error" }));
    expect(harness.fetches()).toBe(0);
  });
});
