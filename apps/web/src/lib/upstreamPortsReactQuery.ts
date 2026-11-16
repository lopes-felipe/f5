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
import { getWsConnectionState, subscribeWsConnectionState } from "../wsConnectionState";
import { onServerWelcome } from "../wsNativeApi";
import { rpcQueryContext, rpcQueryMeta } from "./rpcQueryContext";

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
    // Event-driven refreshes of a loaded overview are background reads.
    queryFn: (context) =>
      ensureNativeApi().upstreamPorts.getOverview({ projectId }, rpcQueryContext(context)),
    meta: rpcQueryMeta("refresh-background"),
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
    // The forwarded signal lets a cancelled refetch stop before its remaining pages.
    queryFn: (context) =>
      ensureNativeApi().upstreamPorts.listTopics(
        {
          projectId,
          list,
          ...(Object.keys(filter).length ? { filter } : {}),
          ...(sort ? { sort } : {}),
          limit: UPSTREAM_LIST_DEFAULT_LIMIT,
          ...(context.pageParam ? { cursor: context.pageParam } : {}),
        },
        rpcQueryContext(context),
      ),
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

/** 0: queue membership; 1: links and topic content; 2: also projects and changed files. */
type UpstreamChangeLevel = 0 | 1 | 2;

/** `null` scopes every project: reconnects and the midnight rollover. */
type UpstreamChangeScope = ProjectId | null;

export const UPSTREAM_INVALIDATION_DEBOUNCE_MS = 150;

const changeLevel = (reason: UpstreamPortsChanged["reason"]): UpstreamChangeLevel =>
  reason === "queue-updated" ? 0 : reason === "links-updated" ? 1 : 2;

const scopedKey = (kind: string, projectId: UpstreamChangeScope) =>
  projectId === null ? ["upstreamPorts", kind] : ["upstreamPorts", kind, projectId];

/**
 * Reloads loaded topic lists from their first page: in-flight fetches are
 * cancelled and later pages dropped, so the refetch costs one page and the
 * rest load again on scroll.
 */
async function reloadTopicPages(queryClient: QueryClient, projectId: UpstreamChangeScope) {
  const queryKey = scopedKey("topics", projectId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueriesData<InfiniteData<UpstreamListTopicsResult, string | null>>(
    { queryKey },
    (data) =>
      data && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : undefined,
  );
  await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
}

/** Resolves true when it joined a fetch that started before the change, so it may predate it. */
async function refreshUpstreamScope(
  queryClient: QueryClient,
  projectId: UpstreamChangeScope,
  level: UpstreamChangeLevel,
): Promise<boolean> {
  // Rows read queue membership from the overview, so queue changes leave topic lists alone.
  const joinable = [scopedKey("overview", projectId), scopedKey("queue", projectId)];
  // The selected topic's detail refreshes on its own; only active queries refetch.
  if (level > 0) joinable.push(scopedKey("topic", projectId));
  const joined = joinable.some((queryKey) => queryClient.isFetching({ queryKey }) > 0);
  const others =
    level === 2
      ? [
          upstreamPortsQueryKeys.projects(),
          projectId === null
            ? upstreamPortsQueryKeys.allTopicFiles
            : ["upstreamPortsFiles", projectId],
        ]
      : [];
  await Promise.all([
    ...[...joinable, ...others].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false }),
    ),
    level > 0 ? reloadTopicPages(queryClient, projectId) : null,
  ]);
  return joined;
}

/**
 * Debounces upstream changes into scoped refreshes. Fetches in flight are
 * joined rather than restarted; a change arriving while a scope refreshes,
 * or a joined fetch that may predate the change, reruns that scope once.
 */
export function createUpstreamPortsInvalidator(queryClient: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const pending = new Map<UpstreamChangeScope, UpstreamChangeLevel>();
  const dirty = new Map<UpstreamChangeScope, UpstreamChangeLevel>();
  const running = new Set<UpstreamChangeScope>();
  const mark = (
    into: Map<UpstreamChangeScope, UpstreamChangeLevel>,
    scope: UpstreamChangeScope,
    level: UpstreamChangeLevel,
  ) => into.set(scope, Math.max(into.get(scope) ?? 0, level) as UpstreamChangeLevel);
  const run = (scope: UpstreamChangeScope, level: UpstreamChangeLevel) => {
    if (disposed) return;
    if (running.has(scope)) {
      mark(dirty, scope, level);
      return;
    }
    running.add(scope);
    const settle = (joined: boolean) => {
      running.delete(scope);
      if (joined) mark(dirty, scope, level);
      const next = dirty.get(scope);
      if (next === undefined) return;
      dirty.delete(scope);
      run(scope, next);
    };
    void refreshUpstreamScope(queryClient, scope, level).then(settle, () => settle(false));
  };
  return {
    schedule(payload?: UpstreamPortsChanged) {
      if (disposed) return;
      if (payload) mark(pending, payload.projectId, changeLevel(payload.reason));
      else mark(pending, null, 2);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = [...pending];
        pending.clear();
        for (const [scope, level] of batch) run(scope, level);
      }, UPSTREAM_INVALIDATION_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Refreshes loaded upstream queries on `upstreamPorts.changed`, on reconnect
 * once synchronization is usable, and at local midnight (derived Watch → Inbox
 * changes by date).
 */
export function useUpstreamPortsInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const api = readNativeApi();
    const invalidator = createUpstreamPortsInvalidator(queryClient);
    const unsubscribeChanged =
      api?.upstreamPorts?.onChanged((payload) => invalidator.schedule(payload)) ?? (() => {});
    let welcomed = false;
    let reconnected = false;
    const refetchOnceSynchronized = () => {
      const connection = getWsConnectionState();
      if (!reconnected || connection.phase !== "connected" || !connection.synchronized) return;
      reconnected = false;
      invalidator.schedule();
    };
    const unsubscribeWelcome = onServerWelcome(() => {
      // The first welcome replays the current connection; only reconnects refetch.
      if (welcomed) {
        reconnected = true;
        refetchOnceSynchronized();
      }
      welcomed = true;
    });
    const unsubscribeConnection = subscribeWsConnectionState(refetchOnceSynchronized);
    let midnight: ReturnType<typeof setTimeout>;
    const armMidnight = () => {
      midnight = setTimeout(() => {
        invalidator.schedule();
        armMidnight();
      }, msUntilLocalMidnight());
    };
    armMidnight();
    return () => {
      unsubscribeChanged();
      unsubscribeWelcome();
      unsubscribeConnection();
      clearTimeout(midnight);
      invalidator.dispose();
    };
  }, [queryClient]);
}
