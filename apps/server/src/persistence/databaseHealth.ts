/**
 * databaseHealth - Process-wide record of profile database corruption.
 *
 * The SQLite client reports SQLITE_CORRUPT/SQLITE_NOTADB here the first time it
 * sees them. Everything that could make recovery harder (snapshots and their
 * pruning, storage cleanup, compaction, VACUUM) checks {@link getDatabaseDamage}
 * and stands down, and the tripwire subscribes to preserve the in-memory read
 * model.
 *
 * Damage is also written to `<db>.damaged`. Ordinary page corruption passes
 * the startup header check, so without the marker a restart would resume
 * snapshots and rotate the good pre-damage copies out within a day. The marker
 * clears itself once the database file is replaced (a restore moves a new file
 * into place, so its inode changes), or when the user deletes it.
 *
 * @module databaseHealth
 */
import * as FS from "node:fs";
import * as Path from "node:path";

// Type-only: the SQLite layer loads this module, and it must stay importable
// by plain Node (strip-types), which cannot resolve the contracts' sources.
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

export function databaseDamageMarkerPath(databasePath: string): string {
  return `${Path.resolve(databasePath)}.damaged`;
}

interface PersistedDamage {
  readonly damage: DatabaseDamage;
  /** Identity of the damaged file; a restored file has a different one. */
  readonly dev: number;
  readonly ino: number;
}

const isNullableString = (value: unknown) => value === null || typeof value === "string";

/** The marker is written only by {@link persist}; anything else is treated as unreadable. */
function decodePersistedDamage(raw: string): PersistedDamage | null {
  const value = JSON.parse(raw) as Partial<PersistedDamage> | null;
  const damage = value?.damage as Partial<DatabaseDamage> | undefined;
  if (
    typeof value?.dev !== "number" ||
    typeof value.ino !== "number" ||
    typeof damage?.detectedAt !== "string" ||
    typeof damage.errorCode !== "number" ||
    typeof damage.message !== "string" ||
    typeof damage.databasePath !== "string" ||
    !isNullableString(damage.recoveryFile) ||
    !isNullableString(damage.recoveryError) ||
    !isNullableString(damage.latestSnapshot)
  ) {
    return null;
  }
  return value as PersistedDamage;
}

function fileIdentity(path: string): { dev: number; ino: number } | null {
  try {
    const stat = FS.statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/** Best-effort: the in-memory record still pauses this run if the write fails. */
function persist(value: DatabaseDamage): void {
  const identity = fileIdentity(value.databasePath);
  if (identity === null) return;
  const temporary = `${value.markerPath}.${process.pid}.tmp`;
  try {
    FS.writeFileSync(temporary, JSON.stringify({ damage: value, ...identity }), { mode: 0o600 });
    FS.renameSync(temporary, value.markerPath);
  } catch {
    FS.rmSync(temporary, { force: true });
  }
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
    recoveryError: null,
    latestSnapshot: null,
    fromPreviousRun: false,
    markerPath: databaseDamageMarkerPath(databasePath),
  };
  persist(damage);
  for (const listener of listeners) notify(listener, damage);
}

export type PersistedDamageLoad = "none" | "loaded" | "cleared";

/**
 * Restores damage recorded by an earlier run before the database is opened.
 * A marker whose file identity no longer matches means the database was
 * replaced, so it is removed.
 */
export function loadPersistedDatabaseDamage(databasePath: string): PersistedDamageLoad {
  const markerPath = databaseDamageMarkerPath(databasePath);
  let raw: string;
  try {
    raw = FS.readFileSync(markerPath, "utf8");
  } catch {
    return "none";
  }
  let persisted: PersistedDamage | null = null;
  try {
    persisted = decodePersistedDamage(raw);
  } catch {
    // Unreadable marker: keep maintenance paused with what we know.
  }
  const identity = fileIdentity(databasePath);
  if (
    persisted !== null &&
    (identity === null || identity.dev !== persisted.dev || identity.ino !== persisted.ino)
  ) {
    FS.rmSync(markerPath, { force: true });
    return "cleared";
  }
  damage = {
    ...(persisted?.damage ?? {
      detectedAt: new Date().toISOString(),
      errorCode: SQLITE_CORRUPT,
      message: "An earlier F5 run recorded database damage.",
      databasePath: Path.resolve(databasePath),
      recoveryFile: null,
      recoveryError: null,
      latestSnapshot: null,
    }),
    fromPreviousRun: true,
    markerPath,
  };
  return "loaded";
}

/** Attaches recovery details after the tripwire has written them. */
export function updateDatabaseDamage(
  patch: Partial<Pick<DatabaseDamage, "recoveryFile" | "recoveryError" | "latestSnapshot">>,
): DatabaseDamage | null {
  if (damage === null) return null;
  damage = { ...damage, ...patch };
  persist(damage);
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
