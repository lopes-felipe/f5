import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { prHubListQueryOptions } from "./prHubReactQuery";
const api = vi.hoisted(() => ({ listPullRequests: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("./prHubAccount", () => ({ getPrHubAccountGeneration: () => "account" }));
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
