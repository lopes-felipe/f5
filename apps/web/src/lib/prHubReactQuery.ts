import { infiniteQueryOptions, queryOptions, type InfiniteData } from "@tanstack/react-query";
import type {
  PrHubListInput,
  PrHubListPage,
  PrHubReviewComment,
  PullRequestKey,
} from "@t3tools/contracts";

import { ensureNativeApi } from "../nativeApi";
import { getPrHubSelectedAccountId, getPrHubAccountGeneration } from "./prHubAccount";

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
    queryKey: [
      ...prHubQueryKeys.overview,
      getPrHubAccountGeneration(),
      stalledBefore,
      getPrHubSelectedAccountId(),
    ],
    placeholderData: (previous, query) =>
      query?.queryKey[2] === getPrHubAccountGeneration() ? previous : undefined,
    queryFn: async () =>
      ensureNativeApi().prHub.getOverview({
        stalledBefore,
        accountId: getPrHubSelectedAccountId(),
      }),
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

/** Shared by the review threads tab and the timeline, which groups replies by thread. */
export function prHubReviewThreadsQueryOptions(key: PullRequestKey) {
  const accountGeneration = getPrHubAccountGeneration();
  return infiniteQueryOptions({
    queryKey: ["prHub", "reviewThreads", accountGeneration, key] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().prHub.getReviewThreads({
        key,
        accountGeneration,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
    staleTime: 30_000,
  });
}

/** Comment pages one thread read can walk before the rest is left to the host. */
const THREAD_COMMENT_PAGES = 5;

/** Every comment of one review thread, for threads the threads read cut short. */
export function prHubReviewThreadCommentsQueryOptions(key: PullRequestKey, threadId: string) {
  const accountGeneration = getPrHubAccountGeneration();
  return queryOptions({
    // Under the threads key, so the invalidations after replies and resolution reach it.
    queryKey: ["prHub", "reviewThreads", accountGeneration, key, threadId, "all"] as const,
    queryFn: async () => {
      const comments: PrHubReviewComment[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < THREAD_COMMENT_PAGES; page++) {
        const result = await ensureNativeApi().prHub.getReviewThreads({
          key,
          accountGeneration,
          threadId,
          ...(cursor ? { cursor } : {}),
        });
        comments.push(...result.threads.flatMap((thread) => thread.comments));
        cursor = result.pageInfo.hasNextPage ? (result.pageInfo.endCursor ?? undefined) : undefined;
        if (!cursor) return { comments, hasNextPage: false };
      }
      return { comments, hasNextPage: true };
    },
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
    // Revision fences cursors, not query identity. Refetch all loaded pages in
    // sequence so a background publication does not collapse the list to page one.
    queryKey: ["prHub", "list", accountGeneration, { ...input, anchorKey: undefined }] as const,
    initialPageParam: undefined as string | undefined,
    placeholderData: (previous, query) =>
      query &&
      query.queryKey[2] === accountGeneration &&
      JSON.stringify({ ...(query.queryKey[3] as PrHubListInput), anchorKey: undefined }) ===
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
