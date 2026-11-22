import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  getPrHubAccountGeneration,
  getPrHubDraftIdentity,
  getPrHubSelectedAccountId,
} from "./prHubAccount";

const STORE = "reads";
const ORDER = "updated";
const MAX_AGE = 30 * 24 * 60 * 60_000;
const MAX_ROWS = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

let database: Promise<IDBDatabase | undefined> | undefined;

function openCache() {
  return (database ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    const request = indexedDB.open("f5-pr-hub-reads", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE).createIndex(ORDER, ["updatedAt", "bytes"]);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      database = undefined;
      resolve(undefined);
    };
  }));
}

async function load(key: string) {
  const db = await openCache();
  if (!db) return;
  return new Promise<{ payload: string; updatedAt: number } | undefined>((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => {
      const row = request.result;
      resolve(
        typeof row?.payload === "string" &&
          typeof row.updatedAt === "number" &&
          row.updatedAt >= Date.now() - MAX_AGE
          ? row
          : undefined,
      );
    };
  });
}

async function save(key: string, data: unknown, updatedAt: number, isCurrent: () => boolean) {
  const db = await openCache();
  if (!db || !isCurrent()) return;
  const payload = JSON.stringify(data);
  const bytes = new TextEncoder().encode(payload).length;
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const read = store.get(key);
  read.onsuccess = () => {
    // A finished request from another tab may already have written a newer answer.
    if (!isCurrent() || read.result?.updatedAt > updatedAt) return;
    if (bytes > MAX_ENTRY_BYTES) {
      store.delete(key);
      return;
    }
    store.put({ payload, bytes, updatedAt }, key);
    const request = store.index(ORDER).openKeyCursor(null, "prev");
    let rows = 0;
    let total = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const [at, size] = cursor.key as [number, number];
      rows += 1;
      total += size;
      if (rows > MAX_ROWS || total > MAX_BYTES || at < updatedAt - MAX_AGE) {
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
  signal: AbortSignal;
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
      context.pageParam !== undefined ||
      context.queryKey[2] !== getPrHubAccountGeneration()
    )
      return fetch(context);
    const query = context.client.getQueryCache().find({ queryKey: context.queryKey, exact: true });
    if (!query) return fetch(context);
    const key = JSON.stringify([scope, context.queryKey]);
    const signal = context.signal;
    const isCurrent = () => !signal.aborted && accountScope() === scope;
    if (query.state.data === undefined) {
      void load(key)
        .then((row) => {
          if (
            !row ||
            !isCurrent() ||
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
    const data = await fetch(context);
    if (isCurrent()) {
      void save(key, data, Date.now(), isCurrent).catch(() => undefined);
    }
    return data;
  };
}
