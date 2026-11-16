import type { ServerProviderSkill } from "@t3tools/contracts";
import { Clock, Effect, Ref, Semaphore } from "effect";
import type { CodexInstanceCatalog } from "./codexModelCatalog";

export const CODEX_CATALOG_TTL_MS = 60 * 60 * 1000;
export const CODEX_CATALOG_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

export function decideCodexCatalogProbe(input: {
  cached: { version: string; catalog: { fetchedAt: string } } | null;
  failure: { version: string; failedAt: number } | null;
  version: string;
  nowMs: number;
}): "probe" | "use-cached" | "use-cached-and-refresh" | "failed-backoff" {
  const failure = input.failure?.version === input.version ? input.failure : null;
  if (failure && input.nowMs - failure.failedAt < CODEX_CATALOG_FAILURE_BACKOFF_MS)
    return "failed-backoff";
  if (input.cached?.version !== input.version) return "probe";
  // A failed refresh must never turn the old catalog authoritative again.
  return failure || input.nowMs - Date.parse(input.cached.catalog.fetchedAt) >= CODEX_CATALOG_TTL_MS
    ? "use-cached-and-refresh"
    : "use-cached";
}

/** Instance-scoped probe cache. The registry alone owns model retention. */
export const makeCodexCatalogCache = <E>(
  probe: (version: string) => Effect.Effect<CodexInstanceCatalog, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const cached = yield* Ref.make<{ version: string; catalog: CodexInstanceCatalog } | null>(null);
    const failure = yield* Ref.make<{ version: string; failedAt: number } | null>(null);
    const skills = yield* Ref.make<{
      version: string;
      rows: ReadonlyArray<ServerProviderSkill>;
    } | null>(null);
    let refreshing = false;
    const probeLocked = (version: string) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(cached);
        const failed = yield* Ref.get(failure);
        const decision = decideCodexCatalogProbe({
          cached: current,
          failure: failed,
          version,
          nowMs,
        });
        if (decision === "use-cached") return current!.catalog;
        if (decision === "failed-backoff") return undefined;
        const result = yield* probe(version).pipe(Effect.option);
        const at = yield* Clock.currentTimeMillis;
        if (result._tag === "None") {
          yield* Ref.set(failure, { version, failedAt: at });
          // Do not re-serve a partial report after a subsequent total failure.
          yield* Ref.set(cached, null);
          return undefined;
        }
        const catalog = { ...result.value, fetchedAt: new Date(at).toISOString() };
        yield* Ref.set(cached, { version, catalog });
        yield* Ref.set(failure, catalog.complete ? null : { version, failedAt: at });
        if (catalog.skills !== undefined) yield* Ref.set(skills, { version, rows: catalog.skills });
        return catalog;
      }).pipe(lock.withPermits(1));

    return {
      read: (version: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(cached);
          const failed = yield* Ref.get(failure);
          const decision = decideCodexCatalogProbe({
            cached: current,
            failure: failed,
            version,
            nowMs: yield* Clock.currentTimeMillis,
          });
          if (decision === "use-cached") return current!.catalog;
          if (decision === "failed-backoff")
            return current && current.version === version && !current.catalog.complete
              ? current.catalog
              : undefined;
          if (decision === "use-cached-and-refresh") {
            if (!refreshing) {
              refreshing = true;
              yield* probeLocked(version).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    refreshing = false;
                  }),
                ),
                Effect.forkIn(scope),
              );
            }
            // Partial rows remain partial; failures never revive an older success.
            return failed?.version === version && current?.catalog.complete
              ? undefined
              : current!.catalog;
          }
          return yield* probeLocked(version);
        }),
      readSkills: (version: string | null | undefined) =>
        Ref.get(skills).pipe(
          Effect.map((current) => (current && current.version === version ? current.rows : [])),
        ),
      invalidate: Effect.gen(function* () {
        yield* Ref.set(cached, null);
        yield* Ref.set(failure, null);
      }),
    };
  });
