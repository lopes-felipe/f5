import type { ClaudeSettings } from "@t3tools/contracts";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { Cache, Clock, Effect, Path, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";
import {
  probeClaudeCapabilities,
  probeClaudeAccountUsage,
  type ClaudeCapabilitiesProbe,
} from "../Layers/ClaudeProvider.ts";
import { makeClaudeCapabilitiesCacheKey } from "./ClaudeHome.ts";
import { ACCOUNT_ATTEMPT_TTL_MS } from "../../usage/accountUsage.ts";

/** Constructed in the instance scope: status checks never invoke the usage scan. */
export const makeClaudeInstanceProbes = (
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  options: { readonly cwd: string; readonly createQuery?: typeof query },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const initialized = yield* Ref.make<{ at: number; value: ClaudeCapabilitiesProbe } | null>(
      null,
    );
    const key = yield* makeClaudeCapabilitiesCacheKey(settings);
    const cache = yield* Cache.make({
      capacity: 4,
      timeToLive: ACCOUNT_ATTEMPT_TTL_MS,
      lookup: () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            // A capabilities miss may have waited behind usage initialization.
            const recent = yield* Ref.get(initialized);
            if (recent && (yield* Clock.currentTimeMillis) - recent.at < ACCOUNT_ATTEMPT_TTL_MS)
              return recent.value;
            return yield* probeClaudeCapabilities(settings, environment, options).pipe(
              Effect.provideService(Path.Path, path),
            );
          }),
        ),
    });
    const usage = lock.withPermits(1)(
      probeClaudeAccountUsage(settings, environment, {
        ...options,
        onCapabilities: (value) =>
          Effect.gen(function* () {
            yield* Ref.set(initialized, { at: yield* Clock.currentTimeMillis, value });
            yield* Cache.set(cache, key, value);
          }),
      }).pipe(Effect.provideService(Path.Path, path)),
    );
    return { capabilities: Cache.get(cache, key), usage };
  });
