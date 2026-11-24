/**
 * Keeps the Cursor account's model catalog on the provider snapshot.
 *
 * Status checks only run `agent about`. The catalog is fetched in the background after a
 * status check, at most once an hour per CLI version and account, and re-applied to
 * every later status snapshot, so a refresh never drops back to the fallback list. The
 * last catalog stays on snapshots that cannot confirm the account (a timed-out or failed
 * `agent about`, a CLI update still being fetched) and is dropped only when Cursor reports
 * the account signed out or another account, or the provider is disabled. After a restart
 * the catalog the previous process published (the persisted provider status) is shown
 * until a fresh one arrives.
 *
 * @module provider/cursor/cursorModelCatalogCache
 */
import type { CursorSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Effect, Ref } from "effect";

import { redactProviderFailureText } from "../failureText.ts";
import {
  CURSOR_LEGACY_MODELS,
  cursorProviderModels,
  type CursorModelCatalogResult,
} from "../Layers/CursorProvider.ts";

export const CURSOR_MODEL_CATALOG_TTL_MS = 60 * 60 * 1000;
/** First retry delay after a failed fetch, doubled per consecutive failure up to the TTL. */
export const CURSOR_MODEL_CATALOG_RETRY_MS = 4 * 60 * 1000;

type CachedCatalogOutcome = Exclude<CursorModelCatalogResult, { readonly _tag: "failed" }>;

export interface CachedCursorModelCatalog {
  /** The CLI build and account it was fetched for. */
  readonly key: string;
  readonly account: string;
  readonly fetchedAt: number;
  readonly outcome: CachedCatalogOutcome;
}

interface CatalogFailure {
  readonly key: string;
  readonly count: number;
  readonly retryAt: number;
}

type CatalogSnapshot = Pick<ServerProvider, "enabled" | "status" | "version" | "auth" | "models">;

const accountOf = (snapshot: Pick<ServerProvider, "auth">) =>
  snapshot.auth.email ?? snapshot.auth.label ?? "";

/**
 * The CLI build and account a catalog is fetched for, or null when no fetch should run:
 * the provider is off, failing, or not confirmed signed in.
 */
export function cursorModelCatalogKey(snapshot: CatalogSnapshot): string | null {
  if (!snapshot.enabled || snapshot.status === "error") return null;
  if (snapshot.auth.status !== "authenticated") return null;
  return JSON.stringify([snapshot.version ?? "", accountOf(snapshot)]);
}

/**
 * The catalog a persisted provider snapshot carried, marked stale so it is refetched as
 * soon as the account is confirmed.
 */
export function seedCursorModelCatalog(
  persisted: CatalogSnapshot | undefined,
): CachedCursorModelCatalog | undefined {
  if (persisted === undefined) return undefined;
  const key = cursorModelCatalogKey(persisted);
  const models = persisted.models.filter((model) => !model.isCustom);
  if (key === null || models.length <= 1) return undefined;
  return {
    key,
    account: accountOf(persisted),
    fetchedAt: Number.NEGATIVE_INFINITY,
    outcome: { _tag: "ok", models },
  };
}

export const makeCursorModelCatalogCache = Effect.fn("makeCursorModelCatalogCache")(
  function* (input: {
    readonly settings: Pick<CursorSettings, "customModels">;
    readonly fetch: Effect.Effect<CursorModelCatalogResult>;
    readonly seed?: CachedCursorModelCatalog | undefined;
    readonly now?: () => number;
  }) {
    const cacheRef = yield* Ref.make<CachedCursorModelCatalog | undefined>(input.seed);
    const failureRef = yield* Ref.make<CatalogFailure | undefined>(undefined);
    const now = input.now ?? Date.now;
    const catalogModels = (outcome: CachedCatalogOutcome) =>
      outcome._tag === "ok" ? outcome.models : CURSOR_LEGACY_MODELS;
    const withCatalog = <S extends CatalogSnapshot>(
      snapshot: S,
      models: ReadonlyArray<ServerProviderModel>,
    ): S => ({ ...snapshot, models: cursorProviderModels(input.settings, models) });

    /** Puts the last catalog on a fresh status snapshot unless it no longer applies. */
    const applyCached = <S extends CatalogSnapshot>(snapshot: S): Effect.Effect<S> =>
      Ref.get(cacheRef).pipe(
        Effect.map((cached) => {
          if (cached === undefined || !snapshot.enabled) return snapshot;
          if (snapshot.auth.status === "unauthenticated") return snapshot;
          const account = accountOf(snapshot);
          if (account !== "" && account !== cached.account) return snapshot;
          return withCatalog(snapshot, catalogModels(cached.outcome));
        }),
      );

    /**
     * Fetches the catalog when none is cached for this CLI version and account, or the
     * cached one is over an hour old. A CLI without the catalog request is not asked
     * again until its version or account changes. A failed fetch leaves the shown models
     * alone and is retried with a growing delay.
     */
    const enrich = (options: {
      readonly snapshot: ServerProvider;
      readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
    }) =>
      Effect.gen(function* () {
        const key = cursorModelCatalogKey(options.snapshot);
        if (key === null) return;
        const cached = yield* Ref.get(cacheRef);
        if (
          cached?.key === key &&
          (cached.outcome._tag === "unsupported" ||
            now() - cached.fetchedAt < CURSOR_MODEL_CATALOG_TTL_MS)
        )
          return;
        const failure = yield* Ref.get(failureRef);
        if (failure?.key === key && now() < failure.retryAt) return;
        const result = yield* input.fetch;
        if (result._tag === "failed") {
          const count = failure?.key === key ? failure.count + 1 : 1;
          const delay = Math.min(
            CURSOR_MODEL_CATALOG_TTL_MS,
            CURSOR_MODEL_CATALOG_RETRY_MS * 2 ** (count - 1),
          );
          yield* Ref.set(failureRef, { key, count, retryAt: now() + delay });
          yield* Effect.logWarning("Cursor model catalog fetch failed", {
            detail: redactProviderFailureText(result.detail),
            consecutiveFailures: count,
            retryInMs: delay,
          });
          return;
        }
        yield* Ref.set(failureRef, undefined);
        yield* Ref.set(cacheRef, {
          key,
          account: accountOf(options.snapshot),
          fetchedAt: now(),
          outcome: result,
        });
        yield* options.publishSnapshot(withCatalog(options.snapshot, catalogModels(result)));
      });

    return { applyCached, enrich };
  },
);
