import {
  UPSTREAM_LIST_DEFAULT_LIMIT,
  type ProjectId,
  type UpstreamListTopicsInput,
  type UpstreamListTopicsResult,
  type UpstreamTopicList,
  type UpstreamTopicSort,
  type UpstreamPortsChanged,
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
  queue: (projectId: ProjectId) => ["upstreamPorts", "queue", projectId] as const,
  /** Every filter and sort of one list; optimistic updates edit them together. */
  list: (projectId: ProjectId, list: UpstreamTopicList) =>
    ["upstreamPorts", "topics", projectId, list] as const,
  topics: (
    projectId: ProjectId,
    list: UpstreamTopicList,
    filter: UpstreamTopicFilter,
    sort: UpstreamTopicSort | null = null,
  ) => ["upstreamPorts", "topics", projectId, list, filter, sort] as const,
  topic: (projectId: ProjectId, topicId: string) =>
    ["upstreamPorts", "topic", projectId, topicId] as const,
  /**
   * Outside `all`: commits do not change, so decisions need not refetch them.
   * Refresh, reconnects and ledger changes (a fetch, a moved base) still do.
   */
  topicFiles: (projectId: ProjectId, topicId: string) =>
    ["upstreamPortsFiles", projectId, topicId] as const,
  allTopicFiles: ["upstreamPortsFiles"] as const,
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
  sort: UpstreamTopicSort | null = null,
) {
  return infiniteQueryOptions({
    queryKey: upstreamPortsQueryKeys.topics(projectId, list, filter, sort),
    queryFn: ({ pageParam }) =>
      ensureNativeApi().upstreamPorts.listTopics({
        projectId,
        list,
        ...(Object.keys(filter).length ? { filter } : {}),
        ...(sort ? { sort } : {}),
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

export function upstreamTopicFilesQueryOptions(projectId: ProjectId, topicId: string | null) {
  return queryOptions({
    queryKey: upstreamPortsQueryKeys.topicFiles(projectId, topicId ?? ""),
    queryFn: () => ensureNativeApi().upstreamPorts.getTopicFiles({ projectId, topicId: topicId! }),
    enabled: topicId !== null,
    // Missing commits appear once the user fetches the upstream remote, so do not keep that answer.
    staleTime: (query) =>
      query.state.data?.commits.some((commit) => !commit.available) ? 0 : 10 * 60_000,
  });
}

/** True when any loaded page mixes revisions or came back stale. */
export function hasStaleTopicPages(
  data: InfiniteData<UpstreamListTopicsResult> | undefined,
): boolean {
  if (!data || data.pages.length === 0) return false;
  const revision = data.pages[0]!.contentRevision;
  return data.pages.some(
    (page) => page.status === "cursor_stale" || page.contentRevision !== revision,
  );
}

/** `files` also refetches changed files: for Refresh, reconnects and server-side changes, not decisions. */
export function invalidateUpstreamPorts(
  queryClient: QueryClient,
  options: { readonly files?: boolean } = {},
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: upstreamPortsQueryKeys.all }),
    options.files
      ? queryClient.invalidateQueries({ queryKey: upstreamPortsQueryKeys.allTopicFiles })
      : null,
  ]).then(() => undefined);
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
    const pending = new Map<ProjectId, number>();
    let refreshAll = false;
    const schedule = (payload?: UpstreamPortsChanged) => {
      if (payload)
        pending.set(
          payload.projectId,
          Math.max(
            pending.get(payload.projectId) ?? 0,
            payload.reason === "queue-updated" ? 0 : payload.reason === "links-updated" ? 1 : 2,
          ),
        );
      else refreshAll = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (refreshAll) void invalidateUpstreamPorts(queryClient, { files: true });
        else
          for (const [projectId, level] of pending) {
            void queryClient.invalidateQueries({
              predicate: (query) =>
                query.queryKey[0] === "upstreamPorts" &&
                ((query.queryKey[2] === projectId &&
                  (level > 0 || query.queryKey[1] !== "topic")) ||
                  (level === 2 && query.queryKey[1] === "projects")),
            });
            if (level === 2)
              void queryClient.invalidateQueries({ queryKey: ["upstreamPortsFiles", projectId] });
          }
        pending.clear();
        refreshAll = false;
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
