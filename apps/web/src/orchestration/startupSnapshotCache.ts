import {
  OrchestrationStartupSnapshot,
  OrchestrationGetStartupSnapshotResult,
  type OrchestrationGetLatestSequenceResult,
  type ThreadId,
} from "@t3tools/contracts";
import { ORCHESTRATION_STARTUP_SNAPSHOT_PATH } from "@t3tools/shared/backendPaths";
import { isLoopbackPreviewHost } from "@t3tools/shared/preview";
import { Schema } from "effect";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";

const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CACHE_READ_TIMEOUT_MS = 250;
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
  readonly snapshotSequence: number;
  readonly snapshot: OrchestrationStartupSnapshot;
}

export function readCachedStartupSnapshot(
  entry: CacheEntry | undefined,
  backendIncarnation: string,
  origin: string,
  now = Date.now(),
) {
  if (
    entry?.backendIncarnation !== backendIncarnation ||
    entry.origin !== origin ||
    !Number.isFinite(entry.savedAt) ||
    entry.savedAt > now ||
    now - entry.savedAt >= CACHE_MAX_AGE_MS ||
    !Number.isSafeInteger(entry.snapshotSequence) ||
    entry.snapshotSequence < 0
  )
    return undefined;
  return {
    sequence: entry.snapshotSequence,
    decode: () => {
      try {
        const snapshot = decodeSnapshot(entry.snapshot);
        return snapshot.snapshotSequence === entry.snapshotSequence ? snapshot : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export function startupReplayEvents(
  result: OrchestrationGetLatestSequenceResult | undefined,
  incarnation: string,
  afterSequence: number,
) {
  if (
    result?.backendIncarnation === incarnation &&
    result.events !== undefined &&
    result.events.length === result.latestSequence - afterSequence &&
    result.events.every((event, index) => event.sequence === afterSequence + index + 1)
  )
    return result.events;
  return undefined;
}

export async function requestStartupSnapshot(
  readWebSocket: () => Promise<OrchestrationGetStartupSnapshotResult>,
  readHttp?: () => Promise<OrchestrationGetStartupSnapshotResult | undefined>,
) {
  return (await readHttp?.().catch(() => undefined)) ?? readWebSocket();
}

async function openCache(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("f5-orchestration-startup", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE).createIndex(SAVED_AT_INDEX, SAVED_AT_INDEX);
    const abort = () => reject(signal?.reason);
    let blocked = false;
    signal?.addEventListener("abort", abort, { once: true });
    request.onsuccess = () => {
      signal?.removeEventListener("abort", abort);
      if (blocked || signal?.aborted) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(request.error);
    };
    request.onblocked = () => {
      blocked = true;
      signal?.removeEventListener("abort", abort);
      reject(new Error("Startup cache is busy."));
    };
  });
}

export const startupSnapshotCache = {
  async read(scope: CacheScope) {
    const origin = getServerHttpOrigin();
    const signal = AbortSignal.timeout(CACHE_READ_TIMEOUT_MS);
    const db = await openCache(signal);
    try {
      const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const transaction = db.transaction(STORE, "readonly");
        const request = transaction.objectStore(STORE).get(scope.profileId ?? origin);
        const abort = () => {
          reject(signal.reason);
          try {
            transaction.abort();
          } catch {
            /* Already settled. */
          }
        };
        signal.addEventListener("abort", abort, { once: true });
        transaction.oncomplete = () => {
          signal.removeEventListener("abort", abort);
          resolve(request.result);
        };
        transaction.onabort = () => {
          signal.removeEventListener("abort", abort);
          reject(transaction.error);
        };
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
      snapshotSequence: snapshot.snapshotSequence,
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
                existing.snapshotSequence > snapshot.snapshotSequence))
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

export async function fetchStartupSnapshot(backendIncarnation: string, detailThreadId?: ThreadId) {
  const url = new URL(ORCHESTRATION_STARTUP_SNAPSHOT_PATH, getServerHttpOrigin());
  if (isLoopbackPreviewHost(url.hostname)) return undefined;
  url.searchParams.set("incarnation", backendIncarnation);
  if (detailThreadId) url.searchParams.set("detailThreadId", detailThreadId);
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not read the startup snapshot.");
  return decodeResult(await response.json());
}
