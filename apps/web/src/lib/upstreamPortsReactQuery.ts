import {
  UPSTREAM_LIST_DEFAULT_LIMIT,
  type ProjectId,
  type UpstreamListTopicsInput,
  type UpstreamListTopicsResult,
  type UpstreamTopicList,
} from "@t3tools/contracts";
import {
  infiniteQueryOptions,
  queryOptions,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { onServerWelcome } from "../wsNativeApi";

export type UpstreamTopicFilter = NonNullable<UpstreamListTopicsInput["filter"]>;

export const upstreamPortsQueryKeys = {
  all: ["upstreamPorts"] as const,
  projects: () => ["upstreamPorts", "projects"] as const,
  overview: (projectId: ProjectId) => ["upstreamPorts", "overview", projectId] as const,
  topics: (projectId: ProjectId, list: UpstreamTopicList, filter: UpstreamTopicFilter) =>
    ["upstreamPorts", "topics", projectId, list, filter] as const,
  topic: (projectId: ProjectId, topicId: string) =>
    ["upstreamPorts", "topic", projectId, topicId] as const,
};

export function upstreamProjectsQueryOptions() {
  return queryOptions({
    queryKey: upstreamPortsQueryKeys.projects(),
    queryFn: () => ensureNativeApi().upstreamPorts.listProjects(),
    staleTime: 60_000,
  });
}

export function upstreamOverviewQueryOptions(projectId: ProjectId) {
  return queryOptions({
    queryKey: upstreamPortsQueryKeys.overview(projectId),
    queryFn: () => ensureNativeApi().upstreamPorts.getOverview({ projectId }),
    staleTime: 30_000,
  });
}

/**
 * Pages are fenced by revision: a page whose cursor went stale comes back with
 * `cursor_stale`, and the caller resets the query so it reloads from the top.
 */
export function upstreamTopicsQueryOptions(
  projectId: ProjectId,
  list: UpstreamTopicList,
  filter: UpstreamTopicFilter = {},
) {
  return infiniteQueryOptions({
    queryKey: upstreamPortsQueryKeys.topics(projectId, list, filter),
    queryFn: ({ pageParam }) =>
      ensureNativeApi().upstreamPorts.listTopics({
        projectId,
        list,
        ...(Object.keys(filter).length ? { filter } : {}),
        limit: UPSTREAM_LIST_DEFAULT_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.status === "ok" ? page.nextCursor : null),
    staleTime: 30_000,
  });
}

export function upstreamTopicQueryOptions(projectId: ProjectId, topicId: string | null) {
  return queryOptions({
    queryKey: upstreamPortsQueryKeys.topic(projectId, topicId ?? ""),
    queryFn: () => ensureNativeApi().upstreamPorts.getTopic({ projectId, topicId: topicId! }),
    enabled: topicId !== null,
    staleTime: 30_000,
  });
}

/** True when any loaded page mixes revisions or came back stale. */
export function hasStaleTopicPages(
  data: InfiniteData<UpstreamListTopicsResult> | undefined,
): boolean {
  if (!data || data.pages.length === 0) return false;
  const revision = data.pages[0]!.revision;
  return data.pages.some((page) => page.status === "cursor_stale" || page.revision !== revision);
}

export function invalidateUpstreamPorts(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: upstreamPortsQueryKeys.all });
}

const msUntilLocalMidnight = (now = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5).getTime() - now.getTime();

/**
 * Refetches every loaded upstream query on `upstreamPorts.changed`, on
 * reconnect, and at local midnight (derived Watch → Inbox changes by date).
 */
export function useUpstreamPortsInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const api = readNativeApi();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void invalidateUpstreamPorts(queryClient);
      }, 150);
    };
    const unsubscribeChanged = api?.upstreamPorts?.onChanged(schedule) ?? (() => {});
    let welcomed = false;
    const unsubscribeWelcome = onServerWelcome(() => {
      // The first welcome replays the current connection; only reconnects refetch.
      if (welcomed) schedule();
      welcomed = true;
    });
    let midnight: ReturnType<typeof setTimeout>;
    const armMidnight = () => {
      midnight = setTimeout(() => {
        schedule();
        armMidnight();
      }, msUntilLocalMidnight());
    };
    armMidnight();
    return () => {
      unsubscribeChanged();
      unsubscribeWelcome();
      clearTimeout(midnight);
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
}
