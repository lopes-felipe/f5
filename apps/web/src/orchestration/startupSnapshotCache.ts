import {
  OrchestrationStartupSnapshot,
  OrchestrationGetStartupSnapshotResult,
} from "@t3tools/contracts";
import { ORCHESTRATION_STARTUP_SNAPSHOT_PATH } from "@t3tools/shared/backendPaths";
import { Schema } from "effect";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";

const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const STORE = "shell";
const SAVED_AT_INDEX = "savedAt";
const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationStartupSnapshot);
const decodeResult = Schema.decodeUnknownSync(OrchestrationGetStartupSnapshotResult);

interface CacheScope {
  readonly backendIncarnation: string;
  readonly profileId: string | undefined;
}

interface CacheEntry {
  readonly backendIncarnation: string;
  readonly origin: string;
  readonly savedAt: number;
  readonly snapshot: OrchestrationStartupSnapshot;
}

export function readCachedStartupSnapshot(
  entry: CacheEntry | undefined,
  backendIncarnation: string,
  origin: string,
  now = Date.now(),
): OrchestrationStartupSnapshot | undefined {
  if (
    entry?.backendIncarnation !== backendIncarnation ||
    entry.origin !== origin ||
    !Number.isFinite(entry.savedAt) ||
    entry.savedAt > now ||
    now - entry.savedAt >= CACHE_MAX_AGE_MS
  )
    return undefined;
  try {
    return decodeSnapshot(entry.snapshot);
  } catch {
    return undefined;
  }
}

async function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("f5-orchestration-startup", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE).createIndex(SAVED_AT_INDEX, SAVED_AT_INDEX);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Startup cache is busy."));
  });
}

export const startupSnapshotCache = {
  async read(scope: CacheScope) {
    const origin = getServerHttpOrigin();
    const db = await openCache();
    try {
      const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readonly");
        const request = transaction.objectStore(STORE).get(scope.profileId ?? origin);
        request.onsuccess = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
      return readCachedStartupSnapshot(entry, scope.backendIncarnation, origin);
    } finally {
      db.close();
    }
  },
  async write(scope: CacheScope, snapshot: OrchestrationStartupSnapshot): Promise<void> {
    const origin = getServerHttpOrigin();
    const key = scope.profileId ?? origin;
    const entry: CacheEntry = {
      backendIncarnation: scope.backendIncarnation,
      origin,
      savedAt: Date.now(),
      snapshot,
    };
    const db = await openCache();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        const previous = store.get(key);
        previous.onsuccess = () => {
          const existing = previous.result as CacheEntry | undefined;
          if (
            existing &&
            (existing.savedAt > entry.savedAt ||
              (existing.backendIncarnation === entry.backendIncarnation &&
                existing.snapshot.snapshotSequence > snapshot.snapshotSequence))
          )
            return;
          store.put(entry, key);
        };
        if (typeof IDBKeyRange !== "undefined") {
          const rows = store
            .index(SAVED_AT_INDEX)
            .openKeyCursor(IDBKeyRange.upperBound(entry.savedAt - CACHE_MAX_AGE_MS, true));
          rows.onsuccess = () => {
            const row = rows.result;
            if (!row) return;
            if (row.primaryKey !== key) store.delete(row.primaryKey);
            row.continue();
          };
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  },
};

export async function fetchStartupSnapshot(backendIncarnation: string) {
  const url = new URL(ORCHESTRATION_STARTUP_SNAPSHOT_PATH, getServerHttpOrigin());
  url.searchParams.set("incarnation", backendIncarnation);
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not read the startup snapshot.");
  return decodeResult(await response.json());
}
