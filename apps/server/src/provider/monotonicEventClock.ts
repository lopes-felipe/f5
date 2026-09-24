import { Clock, DateTime, Effect } from "effect";

/**
 * Creates an ISO-8601 timestamp source whose values strictly increase across
 * calls, at least 1 ms apart, even when the clock has not advanced.
 *
 * Provider runtime events become thread activities ordered by `createdAt`.
 * When an adapter emits several events in one synchronous block (for example
 * a tool's final `item.updated` followed by `item.completed`), plain
 * millisecond timestamps tie and the order falls back to random event ids.
 * Stamping with this clock keeps emission order. Under a burst of N events in
 * one millisecond, timestamps run at most N ms ahead of the wall clock.
 */
export function makeMonotonicIsoClock(): Effect.Effect<string> {
  let lastMillis = Number.NEGATIVE_INFINITY;
  return Effect.map(Clock.currentTimeMillis, (nowMillis) => {
    const millis = Math.max(nowMillis, lastMillis + 1);
    lastMillis = millis;
    return DateTime.formatIso(DateTime.makeUnsafe(millis));
  });
}
