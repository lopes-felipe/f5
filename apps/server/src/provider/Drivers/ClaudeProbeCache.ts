import type { ClaudeSettings } from "@t3tools/contracts";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Cache, Clock, Duration, Effect, Exit, Path, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";
import {
  probeClaudeCapabilities,
  probeClaudeAccountUsage,
  type ClaudeCapabilitiesProbe,
} from "../Layers/ClaudeProvider.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeEnvironment } from "./ClaudeHome.ts";
import { resolveClaudeUserStatePath } from "../claudeInventory.ts";
import { ACCOUNT_ATTEMPT_TTL_MS } from "../../usage/accountUsage.ts";

/**
 * Wraps status checks so a signed-out account never keeps cached probes. A
 * signed-out check drops capabilities and usage; while signed out, each check
 * re-probes capabilities; signing back in drops usage read while signed out.
 */
export const makeClaudeSignOutInvalidation = (input: {
  readonly invalidateProbes: Effect.Effect<void>;
  readonly invalidateUsage: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const signedOut = yield* Ref.make(false);
    return <A extends { readonly auth: { readonly status: string } }, E, R>(
      check: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        if (yield* Ref.get(signedOut)) yield* input.invalidateProbes;
        const provider = yield* check;
        const unauthenticated = provider.auth.status === "unauthenticated";
        const wasSignedOut = yield* Ref.getAndSet(signedOut, unauthenticated);
        if (unauthenticated) {
          yield* input.invalidateProbes;
          yield* input.invalidateUsage;
        } else if (wasSignedOut) {
          yield* input.invalidateUsage;
        }
        return provider;
      });
  });

/** Constructed in the instance scope: status checks never invoke the usage scan. */
export const makeClaudeInstanceProbes = (
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  options: { readonly cwd: string; readonly createQuery?: typeof query },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const probeEnvironment = yield* makeClaudeEnvironment(settings, environment);
    const configDir =
      probeEnvironment.CLAUDE_CONFIG_DIR ||
      path.join(probeEnvironment.HOME || probeEnvironment.USERPROFILE || homedir(), ".claude");
    const accountPath = resolveClaudeUserStatePath(probeEnvironment, configDir);
    const accountIdentity = Effect.promise(async () => {
      try {
        const state: unknown = JSON.parse(await readFile(accountPath, "utf8"));
        if (!state || typeof state !== "object" || !("oauthAccount" in state)) return undefined;
        return JSON.stringify(state.oauthAccount);
      } catch {
        return undefined;
      }
    });
    const lastGood = yield* Ref.make<{
      identity: string | undefined;
      value: ClaudeCapabilitiesProbe;
    } | null>(null);
    const initialized = yield* Ref.make<{
      at: number;
      identity: string | undefined;
      value: ClaudeCapabilitiesProbe;
    } | null>(null);
    const key = yield* makeClaudeCapabilitiesCacheKey(settings);
    const cache = yield* Cache.makeWith({
      capacity: 4,
      // Only a successful probe earns the TTL; a failed one retries on the next check.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.fresh ? ACCOUNT_ATTEMPT_TTL_MS : Duration.zero,
      lookup: () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const identity = yield* accountIdentity;
            // A capabilities miss may have waited behind usage initialization.
            const recent = yield* Ref.get(initialized);
            if (
              recent &&
              recent.identity === identity &&
              (yield* Clock.currentTimeMillis) - recent.at < ACCOUNT_ATTEMPT_TTL_MS
            )
              return { fresh: true, value: recent.value };
            const value = yield* probeClaudeCapabilities(settings, environment, options).pipe(
              Effect.provideService(Path.Path, path),
            );
            if (value !== undefined) {
              yield* Ref.set(lastGood, { identity, value });
              return { fresh: true, value };
            }
            // Consume the fallback once. A miss never earns the normal cache TTL.
            const previous = yield* Ref.getAndSet(lastGood, null);
            return {
              fresh: false,
              value: previous?.identity === identity ? previous?.value : undefined,
            };
          }),
        ),
    });
    const usage = lock.withPermits(1)(
      probeClaudeAccountUsage(settings, environment, {
        ...options,
        onCapabilities: (value) =>
          Effect.gen(function* () {
            const identity = yield* accountIdentity;
            yield* Ref.set(initialized, { at: yield* Clock.currentTimeMillis, identity, value });
            yield* Ref.set(lastGood, { identity, value });
            yield* Cache.set(cache, key, { fresh: true, value });
          }),
      }).pipe(Effect.provideService(Path.Path, path)),
    );
    return {
      capabilities: Cache.get(cache, key).pipe(Effect.map((result) => result.value)),
      usage,
      invalidate: lock.withPermits(1)(
        Ref.set(initialized, null).pipe(
          Effect.andThen(Ref.set(lastGood, null)),
          Effect.andThen(Cache.invalidateAll(cache)),
        ),
      ),
    };
  });
