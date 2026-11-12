/**
 * Turns a random (version 4) UUID into a time-ordered (version 7) one: the
 * first 48 bits become the millisecond timestamp, the rest stays random.
 *
 * Event and command IDs are indexed. A fully random key lands on a random
 * index page with every insert, which made most of the pages F5 rewrote each
 * hour index pages, and each rewritten page is one that hourly database
 * snapshots can no longer share. IDs that sort by creation time append to the
 * same few pages instead.
 *
 * The random part is passed in so callers keep their own entropy source
 * (`crypto.randomUUID()`, or Effect's `Random.nextUUIDv4`).
 */
export function timeOrderedUuid(
  random: string = crypto.randomUUID(),
  nowMs: number = Date.now(),
): string {
  const timestamp = Math.max(0, Math.floor(nowMs)).toString(16).padStart(12, "0").slice(-12);
  // xxxxxxxx-xxxx-Vxxx-...: 12 hex digits of timestamp, then the version digit.
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15)}`;
}
