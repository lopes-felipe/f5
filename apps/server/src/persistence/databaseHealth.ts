/**
 * databaseHealth - Process-wide record of profile database corruption.
 *
 * The SQLite client reports SQLITE_CORRUPT/SQLITE_NOTADB here the first time it
 * sees them. Everything that could make recovery harder (snapshot pruning,
 * storage cleanup, VACUUM) checks {@link getDatabaseDamage} and stands down,
 * and the tripwire subscribes to preserve the in-memory read model.
 *
 * @module databaseHealth
 */
import * as Path from "node:path";

import type { DatabaseDamage } from "@t3tools/contracts";

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

let damage: DatabaseDamage | null = null;
const listeners = new Set<(damage: DatabaseDamage) => void>();

/** Primary result code of a corruption error, or null for anything else. */
export function corruptionErrorCode(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const raw =
    (cause as { errcode?: unknown; errno?: unknown }).errcode ??
    (cause as { errno?: unknown }).errno;
  if (typeof raw !== "number") return null;
  const primary = raw & 0xff;
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB ? primary : null;
}

/**
 * Records corruption of a file-backed database. Only the first report wins;
 * later errors are symptoms of the same damage.
 */
export function reportDatabaseCorruption(databasePath: string, cause: unknown): void {
  if (damage !== null || databasePath === "" || databasePath === ":memory:") return;
  const errorCode = corruptionErrorCode(cause);
  if (errorCode === null) return;
  damage = {
    detectedAt: new Date().toISOString(),
    errorCode,
    message: cause instanceof Error ? cause.message : String(cause),
    databasePath: Path.resolve(databasePath),
    recoveryFile: null,
    latestSnapshot: null,
  };
  for (const listener of listeners) notify(listener, damage);
}

/** Attaches recovery details after the tripwire has written them. */
export function updateDatabaseDamage(
  patch: Partial<Pick<DatabaseDamage, "recoveryFile" | "latestSnapshot">>,
): DatabaseDamage | null {
  if (damage === null) return null;
  damage = { ...damage, ...patch };
  return damage;
}

export function getDatabaseDamage(): DatabaseDamage | null {
  return damage;
}

/** Calls `listener` once per damage, immediately if damage was already seen. */
export function onDatabaseDamage(listener: (damage: DatabaseDamage) => void): () => void {
  listeners.add(listener);
  if (damage !== null) notify(listener, damage);
  return () => listeners.delete(listener);
}

function notify(listener: (damage: DatabaseDamage) => void, value: DatabaseDamage) {
  try {
    listener(value);
  } catch {
    // A failing observer must not turn a SQL error into a crash.
  }
}

/** Test-only reset of process state. */
export function resetDatabaseHealthForTest(): void {
  damage = null;
  listeners.clear();
}
