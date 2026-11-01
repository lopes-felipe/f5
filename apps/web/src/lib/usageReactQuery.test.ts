import type { UsageAccounts } from "@t3tools/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getSummary: vi.fn(), getAccounts: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ usage: api }) }));

import {
  forceRefreshUsageAccounts,
  refreshUsageSummaries,
  usageAccountsQueryOptions,
  usageQueryKeys,
} from "./usageReactQuery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function summaryObserver(client: QueryClient, key: string, fetcher: () => Promise<unknown>) {
  const observer = new QueryObserver(client, {
    queryKey: [...usageQueryKeys.summaries, key],
    queryFn: fetcher,
    staleTime: 30_000,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

const account = (refreshState: "idle" | "queued"): UsageAccounts => [
  {
    key: "codex:a",
    provider: "codex",
    providerInstanceId: null,
    displayName: "Codex",
    enabled: true,
    refreshState,
    sections: [],
  },
];

afterEach(() => vi.resetAllMocks());

describe("refreshUsageSummaries", () => {
  it("awaits a fetch that began before the invalidation, then fetches once more", async () => {
    const client = new QueryClient();
    const first = deferred<string>();
    const calls: Array<string> = [];
    let call = 0;
    const { unsubscribe } = summaryObserver(client, "a", () => {
      call++;
      calls.push(`start-${call}`);
      return call === 1 ? first.promise : Promise.resolve(`fresh-${call}`);
    });
    await flush();
    expect(calls).toEqual(["start-1"]);
    // A usage event lands during the initial load; repeated events collapse.
    const done = refreshUsageSummaries(client);
    void refreshUsageSummaries(client);
    void refreshUsageSummaries(client);
    first.resolve("stale");
    await done;
    await flush();
    expect(calls).toEqual(["start-1", "start-2"]);
    expect(client.getQueryData([...usageQueryKeys.summaries, "a"])).toBe("fresh-2");
    unsubscribe();
  });

  it("collapses invalidations during a refetch into one trailing request", async () => {
    const client = new QueryClient();
    const gates: Array<ReturnType<typeof deferred<number>>> = [];
    const { unsubscribe } = summaryObserver(client, "a", () => {
      const gate = deferred<number>();
      gates.push(gate);
      return gate.promise;
    });
    await flush();
    gates[0]!.resolve(0);
    await flush();
    const firstRefresh = refreshUsageSummaries(client);
    await flush();
    expect(gates).toHaveLength(2);
    // A price change arrives while the refetch is running.
    const second = refreshUsageSummaries(client);
    const third = refreshUsageSummaries(client);
    expect(second).not.toBe(firstRefresh);
    gates[1]!.resolve(1);
    await flush();
    expect(gates).toHaveLength(3);
    gates[2]!.resolve(2);
    await Promise.all([firstRefresh, second, third]);
    expect(gates).toHaveLength(3);
    unsubscribe();
  });

  it("keeps a key stale when its observer leaves before the pre-invalidation fetch resolves", async () => {
    const client = new QueryClient();
    const first = deferred<string>();
    const { unsubscribe } = summaryObserver(client, "a", () => first.promise);
    await flush();
    const done = refreshUsageSummaries(client);
    unsubscribe();
    first.resolve("obsolete");
    await done;
    const state = client.getQueryState([...usageQueryKeys.summaries, "a"]);
    expect(state?.data).toBe("obsolete");
    expect(state?.isInvalidated).toBe(true);
  });

  it("refreshes different keys concurrently and leaves inactive keys stale", async () => {
    const client = new QueryClient();
    const started: Array<string> = [];
    const a = summaryObserver(client, "a", async () => started.push("a"));
    const b = summaryObserver(client, "b", async () => started.push("b"));
    await flush();
    b.unsubscribe();
    started.length = 0;
    await refreshUsageSummaries(client);
    expect(started).toEqual(["a"]);
    expect(client.getQueryState([...usageQueryKeys.summaries, "b"])?.isInvalidated).toBe(true);
    a.unsubscribe();
  });
});

describe("forceRefreshUsageAccounts", () => {
  it("discards a delayed ordinary poll and shares duplicate force requests", async () => {
    const client = new QueryClient();
    const ordinary = deferred<UsageAccounts>();
    api.getAccounts
      .mockImplementationOnce(() => ordinary.promise)
      .mockImplementationOnce(async () => account("queued"));
    const observer = new QueryObserver(client, usageAccountsQueryOptions());
    const unsubscribe = observer.subscribe(() => {});
    await flush();
    // The first load is interactive; once accounts are cached, polls yield to interactive reads.
    expect(api.getAccounts).toHaveBeenLastCalledWith(
      { refresh: "if-stale" },
      { priority: "interactive" },
    );

    const first = forceRefreshUsageAccounts(client);
    const duplicate = forceRefreshUsageAccounts(client);
    expect(duplicate).toBe(first);
    await first;
    expect(api.getAccounts).toHaveBeenCalledTimes(2);
    expect(api.getAccounts).toHaveBeenLastCalledWith(
      { refresh: "force" },
      { priority: "interactive" },
    );
    // The ordinary response arrives late and must not overwrite the forced one.
    ordinary.resolve(account("idle"));
    await flush();
    expect(client.getQueryData<UsageAccounts>(usageQueryKeys.accounts)?.[0]?.refreshState).toBe(
      "queued",
    );
    unsubscribe();
    client.clear();
  });
});
