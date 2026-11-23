import { QueryClient } from "@tanstack/react-query";
import {
  PullRequestKey,
  type PrHubChecksResult,
  type PrHubFilesPage,
  type PrHubTimelinePage,
} from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { setPrHubAccount } from "./prHubAccount";
import { clearPrHubReadCache } from "./prHubReadCache";
import {
  prHubChecksQueryOptions,
  prHubFilesQueryOptions,
  prHubTimelineQueryOptions,
} from "./prHubReactQuery";

const api = vi.hoisted(() => ({ getChecks: vi.fn(), getFiles: vi.fn(), getTimeline: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));

const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#7");
const refreshedAt = "2026-11-22T10:00:00.000Z";

function useFreshAccount() {
  setPrHubAccount({ host: "github.com", generation: crypto.randomUUID(), viewerId: 7 });
}

function pendingRead<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

// A read/write transaction waits for preceding cache reads and writes on the same store.
function cachedReadKeys(): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("f5-pr-hub-reads");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("reads", "readwrite");
      const keys = transaction.objectStore("reads").getAllKeys();
      transaction.oncomplete = () => {
        db.close();
        resolve(keys.result);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

async function waitForSavedQuery(queryKey: readonly unknown[]) {
  const suffix = JSON.stringify(queryKey) + "]";
  await vi.waitFor(async () =>
    expect((await cachedReadKeys()).some((key) => String(key).endsWith(suffix))).toBe(true),
  );
}

afterEach(() => {
  setPrHubAccount(undefined);
  vi.resetAllMocks();
});

it("restores timeline pages in a new query client while the normal read is pending", async () => {
  useFreshAccount();
  const cached = {
    entries: [],
    stale: false,
    refreshedAt,
    pageInfo: { hasNextPage: true, endCursor: "next", truncated: false },
  } satisfies PrHubTimelinePage;
  api.getTimeline.mockResolvedValueOnce(cached);
  const options = prHubTimelineQueryOptions(key);
  const firstClient = new QueryClient();
  await firstClient.fetchInfiniteQuery(options);
  await waitForSavedQuery(options.queryKey);
  firstClient.clear();

  const fromServer = pendingRead<PrHubTimelinePage>();
  api.getTimeline.mockReturnValueOnce(fromServer.promise);
  const reloaded = new QueryClient();
  const requested = reloaded.fetchInfiniteQuery(options);
  try {
    await vi.waitFor(() =>
      expect(reloaded.getQueryData(options.queryKey)).toEqual({
        pages: [cached],
        pageParams: [undefined],
      }),
    );
    expect(reloaded.getQueryState(options.queryKey)?.fetchStatus).toBe("fetching");
    const fresh = { ...cached, pageInfo: { ...cached.pageInfo, endCursor: "fresh" } };
    fromServer.resolve(fresh);
    expect((await requested).pages).toEqual([fresh]);
    expect(api.getTimeline).toHaveBeenCalledTimes(2);
  } finally {
    fromServer.resolve(cached);
    await requested;
    reloaded.clear();
  }
});

it("does not restore checks for a different head or account generation", async () => {
  useFreshAccount();
  const cached = {
    headOid: "old",
    checks: [],
    truncated: false,
    refreshedAt,
  } satisfies PrHubChecksResult;
  api.getChecks.mockResolvedValueOnce(cached);
  const firstClient = new QueryClient();
  const original = prHubChecksQueryOptions(key, "old");
  await firstClient.fetchQuery(original);
  await waitForSavedQuery(original.queryKey);
  firstClient.clear();

  const assertUnseeded = async (head: string) => {
    const options = prHubChecksQueryOptions(key, head);
    const fromServer = pendingRead<PrHubChecksResult>();
    api.getChecks.mockReturnValueOnce(fromServer.promise);
    const client = new QueryClient();
    const read = client.fetchQuery(options);
    try {
      await cachedReadKeys();
      expect(client.getQueryData(options.queryKey)).toBeUndefined();
    } finally {
      fromServer.resolve({ ...cached, headOid: head });
      await read;
      client.clear();
    }
  };
  await assertUnseeded("new");
  useFreshAccount();
  await assertUnseeded("new");
});

it("clears stored reads and fences in-flight writes before the next reload", async () => {
  useFreshAccount();
  await clearPrHubReadCache();
  const checks = {
    headOid: "head",
    checks: [],
    truncated: false,
    refreshedAt,
  } satisfies PrHubChecksResult;
  const options = prHubChecksQueryOptions(key, "head");
  const first = new QueryClient();
  api.getChecks.mockResolvedValueOnce(checks);
  await first.fetchQuery(options);
  await vi.waitFor(async () => expect(await cachedReadKeys()).toHaveLength(1));

  const inFlight = pendingRead<PrHubChecksResult>();
  api.getChecks.mockReturnValueOnce(inFlight.promise);
  const beforeClear = new QueryClient();
  const waiting = beforeClear.fetchQuery(options);
  await vi.waitFor(() => expect(beforeClear.getQueryData(options.queryKey)).toEqual(checks));
  await clearPrHubReadCache();
  inFlight.resolve(checks);
  await waiting;
  expect(await cachedReadKeys()).toEqual([]);

  const afterClear = new QueryClient();
  const live = pendingRead<PrHubChecksResult>();
  api.getChecks.mockReturnValueOnce(live.promise);
  const read = afterClear.fetchQuery(options);
  try {
    await cachedReadKeys();
    expect(afterClear.getQueryData(options.queryKey)).toBeUndefined();
  } finally {
    live.resolve(checks);
    await read;
    first.clear();
    beforeClear.clear();
    afterClear.clear();
  }
});

it("restores file patches for the same comparison while refreshing", async () => {
  useFreshAccount();
  const cached = {
    files: [
      {
        path: "a.txt",
        changeType: "changed",
        patch: "@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
      },
    ],
    stale: false,
    refreshedAt,
    comparison: {
      mode: "current_pr",
      baseRepository: "org/repo",
      headRepository: "org/repo",
      baseRef: "main",
      headRef: "topic",
      baseOid: "base",
      headOid: "head",
      mergeBaseOid: "base",
    },
    pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
  } satisfies PrHubFilesPage;
  api.getFiles.mockResolvedValueOnce(cached);
  const options = prHubFilesQueryOptions({ key, headRefOid: "head" });
  const firstClient = new QueryClient();
  await firstClient.fetchInfiniteQuery(options);
  await waitForSavedQuery(options.queryKey);
  firstClient.clear();

  const fromServer = pendingRead<PrHubFilesPage>();
  api.getFiles.mockReturnValueOnce(fromServer.promise);
  const reloaded = new QueryClient();
  const requested = reloaded.fetchInfiniteQuery(options);
  try {
    await vi.waitFor(() =>
      expect(reloaded.getQueryData(options.queryKey)?.pages[0]).toEqual(cached),
    );
    expect(reloaded.getQueryState(options.queryKey)?.dataUpdateCount).toBe(0);
    const changedHead = prHubFilesQueryOptions({ key, headRefOid: "pushed-head" });
    expect(changedHead.queryKey).toEqual(options.queryKey);
    api.getFiles.mockReturnValueOnce(fromServer.promise);
    const afterPush = new QueryClient();
    const pushed = afterPush.fetchInfiniteQuery(changedHead);
    try {
      await cachedReadKeys();
      expect(afterPush.getQueryData(changedHead.queryKey)).toBeUndefined();
    } finally {
      fromServer.resolve(cached);
      await pushed;
      afterPush.clear();
    }
  } finally {
    fromServer.resolve(cached);
    await requested;
    reloaded.clear();
  }
});
