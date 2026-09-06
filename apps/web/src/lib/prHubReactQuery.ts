import { infiniteQueryOptions, queryOptions, type InfiniteData } from "@tanstack/react-query";
import type { PrHubListInput, PrHubListPage, PullRequestKey } from "@t3tools/contracts";

import { ensureNativeApi } from "../nativeApi";
import { getPrHubAccountGeneration } from "./prHubAccount";

export const prHubQueryKeys = {
  overview: ["prHub", "overview"] as const,
  advisories: (keys: readonly PullRequestKey[] = []) =>
    ["prHub", "advisories", getPrHubAccountGeneration(), [...keys].sort()] as const,
  detail: (key: PullRequestKey) => ["prHub", "detail", getPrHubAccountGeneration(), key] as const,
  timeline: (key: PullRequestKey) =>
    ["prHub", "timeline", getPrHubAccountGeneration(), key] as const,
  files: (key: PullRequestKey) => ["prHub", "files", getPrHubAccountGeneration(), key] as const,
};

export function prHubOverviewQueryOptions(stalledBefore?: string) {
  return queryOptions({
    queryKey: [...prHubQueryKeys.overview, getPrHubAccountGeneration(), stalledBefore],
    placeholderData: (previous, query) =>
      query?.queryKey[2] === getPrHubAccountGeneration() ? previous : undefined,
    queryFn: async () => ensureNativeApi().prHub.getOverview({ stalledBefore }),
    staleTime: 30_000,
  });
}

export function prHubDetailQueryOptions(key: PullRequestKey) {
  const accountGeneration = getPrHubAccountGeneration();
  return queryOptions({
    queryKey: prHubQueryKeys.detail(key),
    queryFn: async () => ensureNativeApi().prHub.getDetail({ key, accountGeneration }),
    staleTime: 30_000,
  });
}

export function prHubTimelineQueryOptions(key: PullRequestKey) {
  const accountGeneration = getPrHubAccountGeneration();
  return infiniteQueryOptions({
    queryKey: prHubQueryKeys.timeline(key),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      ensureNativeApi().prHub.getTimeline({
        key,
        accountGeneration,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
    staleTime: 30_000,
  });
}

export function prHubFilesQueryOptions(
  key: PullRequestKey,
  comparisonMode: "current_pr" | "changes_since_review" = "current_pr",
) {
  const accountGeneration = getPrHubAccountGeneration();
  return infiniteQueryOptions({
    queryKey: [...prHubQueryKeys.files(key), comparisonMode],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      ensureNativeApi().prHub.getFiles({
        key,
        accountGeneration,
        comparisonMode,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
    staleTime: 30_000,
  });
}

export function prHubAdvisoriesQueryOptions(keys: readonly PullRequestKey[] = []) {
  const accountGeneration = getPrHubAccountGeneration();
  const sortedKeys = [...keys].sort();
  return queryOptions({
    queryKey: prHubQueryKeys.advisories(sortedKeys),
    queryFn: async () =>
      ensureNativeApi().prHub.getAdvisories({ keys: sortedKeys, accountGeneration }),
    staleTime: 30_000,
  });
}

export function prHubListQueryOptions(input: PrHubListInput, revision: string | undefined) {
  const accountGeneration = getPrHubAccountGeneration();
  return infiniteQueryOptions<
    PrHubListPage,
    Error,
    InfiniteData<PrHubListPage>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: ["prHub", "list", accountGeneration, revision, input] as const,
    initialPageParam: undefined as string | undefined,
    placeholderData: (previous, query) =>
      query &&
      query.queryKey[2] === accountGeneration &&
      JSON.stringify({ ...(query.queryKey[4] as PrHubListInput), anchorKey: undefined }) ===
        JSON.stringify({ ...input, anchorKey: undefined })
        ? previous
        : undefined,
    queryFn: async ({ pageParam }) => {
      const page = await ensureNativeApi().prHub.listPullRequests({
        ...input,
        accountGeneration,
        cursor: pageParam,
      });
      if (page.status === "cursor_stale") throw new Error("cursor_stale");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    enabled: revision !== undefined,
    staleTime: 30_000,
  });
}
