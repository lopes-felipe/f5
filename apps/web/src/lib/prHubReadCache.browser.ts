import { QueryClient } from "@tanstack/react-query";
import {
  PullRequestKey,
  type PrHubChecksResult,
  type PrHubFilesPage,
  type PrHubTimelinePage,
} from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { setPrHubAccount } from "./prHubAccount";
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
  await firstClient.fetchQuery(prHubChecksQueryOptions(key, "old"));
  firstClient.clear();

  const assertUnseeded = async (head: string) => {
    const options = prHubChecksQueryOptions(key, head);
    const fromServer = pendingRead<PrHubChecksResult>();
    api.getChecks.mockReturnValueOnce(fromServer.promise);
    const client = new QueryClient();
    const read = client.fetchQuery(options);
    try {
      // The cache read is asynchronous. Leave the live request pending during restoration.
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
  } satisfies PrHubFilesPage;
  api.getFiles.mockResolvedValueOnce(cached);
  const options = prHubFilesQueryOptions(key);
  const firstClient = new QueryClient();
  await firstClient.fetchInfiniteQuery(options);
  firstClient.clear();

  const fromServer = pendingRead<PrHubFilesPage>();
  api.getFiles.mockReturnValueOnce(fromServer.promise);
  const reloaded = new QueryClient();
  const requested = reloaded.fetchInfiniteQuery(options);
  try {
    await vi.waitFor(() =>
      expect(reloaded.getQueryData(options.queryKey)?.pages[0]).toEqual(cached),
    );
  } finally {
    fromServer.resolve(cached);
    await requested;
    reloaded.clear();
  }
});
