import { resolve } from "node:path";
import { Effect, Semaphore, ServiceMap } from "effect";

// Profile backends have a single connection-owned instance lock. Every path
// that destroys durable attachment bytes participates in this local lease.
// It deliberately does not hold the engine gate or an application transaction.
const HeldLeases = ServiceMap.Reference<ReadonlySet<string>>(
  "f5/storage/AttachmentRetentionLeases",
  { defaultValue: () => new Set<string>() },
);
const leases = new Map<string, { lock: Semaphore.Semaphore; users: number }>();

export function withAttachmentRetentionLease<A, E, R>(
  directory: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const key = resolve(directory);
    const held = yield* HeldLeases;
    if (held.has(key)) return yield* effect;
    const next = new Set(held);
    next.add(key);
    const entry = leases.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(key, entry);
    entry.users++;
    return yield* entry.lock.withPermit(effect.pipe(Effect.provideService(HeldLeases, next))).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (--entry.users === 0) leases.delete(key);
        }),
      ),
    );
  });
}
