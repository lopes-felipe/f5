import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { prHubListQueryOptions, prHubPeekQueryOptions } from "./prHubReactQuery";
const api = vi.hoisted(() => ({ listPullRequests: vi.fn(), peek: vi.fn() }));
const account = vi.hoisted(() => ({ generation: "account", id: "first" }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("./prHubAccount", () => ({
  getPrHubAccountGeneration: () => account.generation,
  getPrHubSelectedAccountId: () => account.id,
}));
it("caches peeks within an account and captures the account used by each query", async () => {
  const client = new QueryClient();
  const url = "https://github.com/org/repo/pull/7";
  api.peek.mockResolvedValue(null);
  try {
    const options = prHubPeekQueryOptions(url);
    expect(options.queryKey).toEqual(["prHub", "peek", "account", "first", url]);
    account.id = "second";
    await client.fetchQuery(options);
    await client.fetchQuery(options);
    expect(api.peek).toHaveBeenCalledExactlyOnceWith({ url, accountId: "first" });
    expect(prHubPeekQueryOptions(url).queryKey).not.toEqual(options.queryKey);
    account.id = "first";
    account.generation = "replacement";
    expect(prHubPeekQueryOptions(url).queryKey).not.toEqual(options.queryKey);
  } finally {
    account.id = "first";
    account.generation = "account";
    client.clear();
  }
});
it("refetches every loaded page when a publication changes without changing query identity", async () => {
  let revision = "one";
  api.listPullRequests.mockImplementation(async (input: { cursor?: string }) => ({
    status: "ok",
    revision,
    accountGeneration: "account",
    pullRequests: [],
    nextCursor: input.cursor ? null : `${revision}:next`,
  }));
  const client = new QueryClient();
  const options = prHubListQueryOptions({}, revision);
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(2);
    revision = "two";
    const next = prHubListQueryOptions({}, revision);
    expect(next.queryKey).toEqual(options.queryKey);
    observer.setOptions(next);
    await observer.refetch();
    expect(observer.getCurrentResult().data?.pages.map((page) => page.revision)).toEqual([
      "two",
      "two",
    ]);
  } finally {
    unsubscribe();
    client.clear();
  }
});
