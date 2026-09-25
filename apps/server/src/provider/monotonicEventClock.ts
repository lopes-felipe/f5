import { Clock, DateTime, Effect } from "effect";

// A key whose last stamp is this far behind the clock can no longer affect
// its next stamp, so it is safe to forget. The margin keeps ordering intact
// across small backward wall-clock corrections.
const IDLE_KEY_RETENTION_MS = 60_000;
const MIN_PRUNE_SIZE = 64;

/**
 * Creates an ISO-8601 timestamp source whose values strictly increase per key
 * (for example per thread), at least 1 ms apart, even when the clock has not
 * advanced.
 *
 * Provider runtime events become thread activities ordered by `createdAt`.
 * When an adapter emits several events in one synchronous block (for example
 * a tool's final `item.updated` followed by `item.completed`), plain
 * millisecond timestamps tie and the order falls back to random event ids.
 * Stamping with this clock keeps emission order within a key.
 *
 * Keys are independent, so busy threads never push other threads' stamps
 * ahead. A key's stamps run ahead of the clock only while that key emits more
 * than one event per millisecond; the lead equals the excess events and
 * shrinks by 1 ms for every millisecond in which the key emits nothing.
 */
export function makeMonotonicIsoClock(): (key: string) => Effect.Effect<string> {
  const lastMillisByKey = new Map<string, number>();
  let pruneAtSize = MIN_PRUNE_SIZE;

  const pruneIdleKeys = (nowMillis: number) => {
    const cutoff = nowMillis - IDLE_KEY_RETENTION_MS;
    for (const [key, lastMillis] of lastMillisByKey) {
      if (lastMillis < cutoff) {
        lastMillisByKey.delete(key);
      }
    }
    // Amortized O(1): the next sweep waits until the live set doubles.
    pruneAtSize = Math.max(MIN_PRUNE_SIZE, lastMillisByKey.size * 2);
  };

  return (key) =>
    Effect.map(Clock.currentTimeMillis, (nowMillis) => {
      const lastMillis = lastMillisByKey.get(key);
      const millis = lastMillis === undefined ? nowMillis : Math.max(nowMillis, lastMillis + 1);
      lastMillisByKey.set(key, millis);
      if (lastMillisByKey.size >= pruneAtSize) {
        pruneIdleKeys(nowMillis);
      }
      return DateTime.formatIso(DateTime.makeUnsafe(millis));
    });
}
