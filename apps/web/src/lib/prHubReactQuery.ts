import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { PullRequestKey } from "@t3tools/contracts";

import { ensureNativeApi } from "../nativeApi";

export const prHubQueryKeys = {
  snapshot: ["prHub", "snapshot"] as const,
  advisories: (keys: readonly PullRequestKey[] = []) =>
    ["prHub", "advisories", [...keys].sort()] as const,
  detail: (key: PullRequestKey) => ["prHub", "detail", key] as const,
  timeline: (key: PullRequestKey) => ["prHub", "timeline", key] as const,
  files: (key: PullRequestKey) => ["prHub", "files", key] as const,
};

export function prHubSnapshotQueryOptions() {
  return queryOptions({
    queryKey: prHubQueryKeys.snapshot,
    queryFn: async () => ensureNativeApi().prHub.getSnapshot(),
    staleTime: 30_000,
  });
}

export function prHubDetailQueryOptions(key: PullRequestKey) {
  return queryOptions({
    queryKey: prHubQueryKeys.detail(key),
    queryFn: async () => ensureNativeApi().prHub.getDetail({ key }),
    staleTime: 30_000,
  });
}

export function prHubTimelineQueryOptions(key: PullRequestKey) {
  return infiniteQueryOptions({
    queryKey: prHubQueryKeys.timeline(key),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      ensureNativeApi().prHub.getTimeline({ key, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
    staleTime: 30_000,
  });
}

export function prHubFilesQueryOptions(key: PullRequestKey) {
  return infiniteQueryOptions({
    queryKey: prHubQueryKeys.files(key),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      ensureNativeApi().prHub.getFiles({ key, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) =>
      page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
    staleTime: 30_000,
  });
}

export function prHubAdvisoriesQueryOptions(keys: readonly PullRequestKey[] = []) {
  const sortedKeys = [...keys].sort();
  return queryOptions({
    queryKey: prHubQueryKeys.advisories(sortedKeys),
    queryFn: async () => ensureNativeApi().prHub.getAdvisories({ keys: sortedKeys }),
    staleTime: 30_000,
  });
}
