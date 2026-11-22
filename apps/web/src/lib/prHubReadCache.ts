import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  getPrHubAccountGeneration,
  getPrHubDraftIdentity,
  getPrHubSelectedAccountId,
} from "./prHubAccount";

const STORE = "reads";
const META = "meta";
const ORDER = "updated";
const MAX_AGE = 30 * 24 * 60 * 60_000;
const MAX_ROWS = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const BATCH_ROWS = 32;
const BATCH_BYTES = 1024 * 1024;

let database: Promise<IDBDatabase | undefined> | undefined;
let clearVersion = 0;
let clearing = false;

function openCache() {
  return (database ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    const request = indexedDB.open("f5-pr-hub-reads", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE).createIndex(ORDER, ["updatedAt", "bytes"]);
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const expired = store
        .index(ORDER)
        .openKeyCursor(IDBKeyRange.upperBound([Date.now() - MAX_AGE], true));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      resolve(db);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}

/** Clear disposable PR reads in this browser, including writes still running in other tabs. */
export async function clearPrHubReadCache() {
  const version = ++clearVersion;
  clearing = true;
  try {
    const db = await openCache();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE, META], "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore(STORE).clear();
      const meta = transaction.objectStore(META);
      const epoch = meta.get("epoch");
      epoch.onsuccess = () => {
        meta.delete("batch");
        meta.put(
          Math.max(performance.timeOrigin + performance.now(), (epoch.result ?? 0) + 0.001),
          "epoch",
        );
      };
    });
  } finally {
    if (version === clearVersion) clearing = false;
  }
}

async function load(key: string, includeRow: boolean) {
  const db = await openCache();
  if (!db) return;
  return new Promise<
    { epoch: number | undefined; row?: { payload: string; updatedAt: number } } | undefined
  >((resolve) => {
    const transaction = db.transaction(includeRow ? [STORE, META] : [META]);
    const epoch = transaction.objectStore(META).get("epoch");
    const request = includeRow ? transaction.objectStore(STORE).get(key) : undefined;
    transaction.onabort = () => resolve(undefined);
    transaction.oncomplete = () => {
      const row = request?.result;
      resolve(
        typeof row?.payload === "string" &&
          typeof row.updatedAt === "number" &&
          row.updatedAt >= Date.now() - MAX_AGE
          ? { epoch: epoch.result, row }
          : { epoch: epoch.result },
      );
    };
  });
}

async function save(
  key: string,
  data: unknown,
  updatedAt: number,
  epoch: number | undefined,
  isCurrent: () => boolean,
) {
  const db = await openCache();
  if (!db || !isCurrent()) return;
  const payload = JSON.stringify(data);
  const transaction = db.transaction([STORE, META], "readwrite");
  const store = transaction.objectStore(STORE);
  const meta = transaction.objectStore(META);
  const currentEpoch = meta.get("epoch");
  const batch = meta.get("batch");
  const read = store.get(key);
  read.onsuccess = () => {
    // A finished request from another tab may already have written a newer answer.
    if (
      !isCurrent() ||
      currentEpoch.result !== epoch ||
      (epoch !== undefined && updatedAt < epoch) ||
      read.result?.updatedAt > updatedAt ||
      (read.result?.payload === payload && read.result.updatedAt >= updatedAt - MAX_AGE / 2)
    )
      return;
    const bytes = new TextEncoder().encode(payload).length;
    if (bytes > MAX_ENTRY_BYTES) {
      store.delete(key);
      return;
    }
    store.put({ payload, bytes, updatedAt }, key);
    const writtenRows = (batch.result?.rows ?? BATCH_ROWS) + 1;
    const writtenBytes = (batch.result?.bytes ?? 0) + bytes;
    if (writtenRows < BATCH_ROWS && writtenBytes < BATCH_BYTES) {
      meta.put({ rows: writtenRows, bytes: writtenBytes }, "batch");
      return;
    }
    meta.put({ rows: 0, bytes: 0 }, "batch");
    const request = store.index(ORDER).openKeyCursor(null, "prev");
    let rows = 0;
    let total = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const [at, size] = cursor.key as [number, number];
      rows += 1;
      total += size;
      if (
        rows > MAX_ROWS - BATCH_ROWS ||
        total > MAX_BYTES - BATCH_BYTES ||
        at < updatedAt - MAX_AGE
      ) {
        store.delete(cursor.primaryKey);
      }
      cursor.continue();
    };
  };
}

function accountScope() {
  const identity = getPrHubDraftIdentity();
  const generation = getPrHubAccountGeneration();
  return identity && generation
    ? JSON.stringify([getPrHubSelectedAccountId(), identity, generation])
    : undefined;
}

interface ReadContext {
  client: QueryClient;
  queryKey: QueryKey;
  pageParam?: unknown;
}

/** Restore the first page while its normal read is in flight. Pagination keeps using live cursors. */
export function persistPrHubRead<A>(
  fetch: (context: ReadContext) => Promise<A>,
  decode: (input: unknown) => A | undefined,
  paginated = false,
) {
  return async (context: ReadContext): Promise<A> => {
    const scope = accountScope();
    if (
      !scope ||
      clearing ||
      context.pageParam !== undefined ||
      context.queryKey[2] !== getPrHubAccountGeneration()
    )
      return fetch(context);
    const query = context.client.getQueryCache().find({ queryKey: context.queryKey, exact: true });
    if (!query) return fetch(context);
    const key = JSON.stringify([scope, context.queryKey]);
    const version = clearVersion;
    const isCurrent = () => version === clearVersion && !clearing && accountScope() === scope;
    const canRestore = query.state.data === undefined;
    const stored = load(key, canRestore).catch(() => undefined);
    if (canRestore) {
      void stored
        .then((answer) => {
          const row = answer?.row;
          if (
            !row ||
            !isCurrent() ||
            context.client.getQueryCache().find({ queryKey: context.queryKey, exact: true }) !==
              query ||
            query.state.data !== undefined ||
            query.state.fetchStatus !== "fetching"
          )
            return;
          const page = decode(JSON.parse(row.payload));
          if (page === undefined) return;
          // Leave the fetch counters alone so dependent reads can wait for a live result.
          query.setState({
            data: paginated ? { pages: [page], pageParams: [undefined] } : page,
            dataUpdatedAt: row.updatedAt,
            status: "success",
          });
        })
        .catch(() => undefined);
    }
    const updatedAt = performance.timeOrigin + performance.now();
    const data = await fetch(context);
    if (isCurrent()) {
      void stored
        .then((answer) => {
          if (answer) return save(key, data, updatedAt, answer.epoch, isCurrent);
        })
        .catch(() => undefined);
    }
    return data;
  };
}
