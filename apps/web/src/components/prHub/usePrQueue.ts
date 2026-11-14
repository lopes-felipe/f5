import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type {
  PrHubAdvisory,
  PrHubListPage,
  PrHubOverview,
  PrHubSection,
  PrHubThreadLink,
  PullRequestKey,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { PR_HUB_SECTIONS } from "@t3tools/shared/prHub";
import { sourceControlPullRequestKeysEqual } from "@t3tools/shared/sourceControl";

import {
  prHubAdvisoriesQueryOptions,
  prHubListQueryOptions,
  prHubOverviewQueryOptions,
} from "../../lib/prHubReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { onPrHubAdvisoriesUpdated } from "../../wsNativeApi";
import { prQueueCollapsed } from "./prQueueModel";
import { prQueueIsFiltered, prQueueListInput, type PrQueueSearch } from "./prQueueSearch";

type ListQuery = UseInfiniteQueryResult<InfiniteData<PrHubListPage>, Error>;

export interface PrQueueGroup {
  /** Null for a status list (snoozed, ignored, closed), which has no sections. */
  readonly section: PrHubSection | null;
  /** Rows the server reports for the section, or the rows loaded so far. */
  readonly count: number;
  /** More rows than `count` may match; shown as "25+". */
  readonly countIsPartial: boolean;
  /** Null when the group cannot be collapsed (search results, status lists). */
  readonly collapsed: boolean | null;
  readonly rows: readonly TrackedPullRequest[];
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly isError: boolean;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

export interface PrQueue {
  readonly overview: PrHubOverview | undefined;
  readonly groups: readonly PrQueueGroup[];
  /** Rows on screen in order: what the keyboard moves through. */
  readonly rows: readonly TrackedPullRequest[];
  readonly threadLinks: ReadonlyMap<string, readonly PrHubThreadLink[]>;
  /** Nothing to show yet; a group still loading its first rows says so itself. */
  readonly isLoading: boolean;
  /** The rows belong to the previous search or filter while the next one loads. */
  readonly isStale: boolean;
  readonly isError: boolean;
  /** The pull request named in the URL, loaded on its own when it is not among the rows. */
  readonly openPr: TrackedPullRequest | null;
  readonly isOpenPrLoading: boolean;
  readonly refetch: () => void;
}

const rowsOf = (query: ListQuery) => query.data?.pages.flatMap((page) => page.pullRequests) ?? [];

function useSectionQuery(section: PrHubSection, revision: string | undefined, enabled: boolean) {
  return useInfiniteQuery(
    prHubListQueryOptions(prQueueListInput({}, section), enabled ? revision : undefined),
  );
}

/**
 * Reads the queue for the current URL state. Without a search or filter, each expanded
 * section is its own paginated request, so collapsed sections cost nothing. A search, a
 * filter or another status is one request, grouped by the section stamped on each row.
 */
export function usePrQueue(
  search: PrQueueSearch,
  storedCollapse: Partial<Record<PrHubSection, boolean>>,
): PrQueue {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery(prHubOverviewQueryOptions());
  const overview = overviewQuery.data;
  const revision = overview?.revision;
  const status = search.status ?? "active";
  const mode = status !== "active" ? "status" : prQueueIsFiltered(search) ? "filtered" : "sections";
  const counts = overview?.sectionCounts;
  const wants = (section: PrHubSection) =>
    mode === "sections" &&
    !prQueueCollapsed(storedCollapse, section) &&
    (counts?.[section] ?? 0) > 0;

  const sectionQueries: Record<PrHubSection, ListQuery> = {
    review: useSectionQuery("review", revision, wants("review")),
    action: useSectionQuery("action", revision, wants("action")),
    ready: useSectionQuery("ready", revision, wants("ready")),
    waiting: useSectionQuery("waiting", revision, wants("waiting")),
    drafts: useSectionQuery("drafts", revision, wants("drafts")),
    team: useSectionQuery("team", revision, wants("team")),
    other: useSectionQuery("other", revision, wants("other")),
    stale: useSectionQuery("stale", revision, wants("stale")),
  };
  const flatQuery: ListQuery = useInfiniteQuery(
    prHubListQueryOptions(prQueueListInput(search), mode === "sections" ? undefined : revision, {
      keepPrevious: true,
    }),
  );
  const queries = [...PR_HUB_SECTIONS.map((section) => sectionQueries[section]), flatQuery];

  // A stale cursor means the queue moved under a loaded page: re-read from the start.
  const hasStaleCursor = queries.some((query) => query.error?.message === "cursor_stale");
  useEffect(() => {
    if (!hasStaleCursor) return;
    void queryClient.invalidateQueries({ queryKey: ["prHub", "overview"] });
    void queryClient.invalidateQueries({ queryKey: ["prHub", "list"] });
  }, [hasStaleCursor, queryClient]);

  // Until the first search result arrives, the unfiltered sections stay on screen.
  const showFlat = mode !== "sections" && flatQuery.data !== undefined;
  const flatRows = useMemo(() => rowsOf(flatQuery), [flatQuery.data]);

  const groupOf = (
    section: PrHubSection | null,
    query: ListQuery,
    rows: readonly TrackedPullRequest[],
    extra: Pick<PrQueueGroup, "count" | "countIsPartial" | "collapsed" | "hasMore">,
  ): PrQueueGroup => ({
    section,
    rows,
    ...extra,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isLoadingMore: query.isFetchingNextPage,
    isError: query.isError && !query.isFetching && query.error?.message !== "cursor_stale",
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
  });

  let groups: PrQueueGroup[];
  if (showFlat && mode === "status") {
    groups =
      flatRows.length > 0
        ? [
            groupOf(null, flatQuery, flatRows, {
              count: flatRows.length,
              countIsPartial: flatQuery.hasNextPage,
              collapsed: null,
              hasMore: flatQuery.hasNextPage,
            }),
          ]
        : [];
  } else if (showFlat) {
    const sections = PR_HUB_SECTIONS.filter((section) =>
      flatRows.some((pr) => pr.section === section),
    );
    groups = sections.map((section, index) => {
      const rows = flatRows.filter((pr) => pr.section === section);
      const last = index === sections.length - 1;
      return groupOf(section, flatQuery, rows, {
        count: rows.length,
        countIsPartial: last && flatQuery.hasNextPage,
        collapsed: null,
        hasMore: last && flatQuery.hasNextPage,
      });
    });
  } else if (mode === "status") {
    groups = [];
  } else {
    groups = PR_HUB_SECTIONS.filter((section) => (counts?.[section] ?? 0) > 0).map((section) => {
      const query = sectionQueries[section];
      const collapsed = prQueueCollapsed(storedCollapse, section);
      return groupOf(section, query, collapsed ? [] : rowsOf(query), {
        count: counts?.[section] ?? 0,
        countIsPartial: false,
        collapsed,
        hasMore: !collapsed && query.hasNextPage,
      });
    });
  }

  const rows = groups.flatMap((group) => group.rows);
  const threadLinks = new Map<string, readonly PrHubThreadLink[]>();
  for (const query of queries)
    for (const page of query.data?.pages ?? [])
      for (const [key, links] of Object.entries(page.threadLinks ?? {}))
        threadLinks.set(key, links);

  const openKey = search.pr;
  const loaded = openKey
    ? (queries
        .flatMap(rowsOf)
        .find((pr) => pr.key === openKey || sourceControlPullRequestKeysEqual(pr.key, openKey)) ??
      null)
    : null;
  const openQuery = useInfiniteQuery(
    prHubListQueryOptions(
      { ...(openKey ? { key: openKey as PullRequestKey } : {}), limit: 1 },
      openKey && !loaded ? revision : undefined,
    ),
  );
  const fetched = openKey ? (openQuery.data?.pages[0]?.pullRequests[0] ?? null) : null;
  for (const [key, links] of Object.entries(openQuery.data?.pages[0]?.threadLinks ?? {}))
    if (!threadLinks.has(key)) threadLinks.set(key, links);

  return {
    overview,
    groups,
    rows,
    threadLinks,
    isLoading: overviewQuery.isPending || (mode === "status" && !showFlat && !flatQuery.isError),
    isStale: mode !== "sections" && (!showFlat || flatQuery.isPlaceholderData),
    isError: overviewQuery.isError || (mode !== "sections" && flatQuery.isError && !showFlat),
    openPr: loaded ?? fetched,
    isOpenPrLoading: Boolean(openKey) && !loaded && !fetched && !openQuery.isError,
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ["prHub", "overview"] });
      void queryClient.invalidateQueries({ queryKey: ["prHub", "list"] });
    },
  };
}

/** The AI recommendation for one pull request, refreshed when the server reports a new one. */
export function usePrAdvisory(key: PullRequestKey | null): {
  advisory: PrHubAdvisory | undefined;
  isAnalyzing: boolean;
  analyze: () => void;
} {
  const queryClient = useQueryClient();
  const keys = useMemo(() => (key ? [key] : []), [key]);
  const query = useQuery({ ...prHubAdvisoriesQueryOptions(keys), enabled: keys.length > 0 });
  useEffect(
    () =>
      onPrHubAdvisoriesUpdated(() => {
        void queryClient.invalidateQueries({ queryKey: ["prHub", "advisories"] });
      }),
    [queryClient],
  );
  const [analyzing, setAnalyzing] = useState<PullRequestKey | null>(null);
  const analyze = useCallback(() => {
    if (!key) return;
    setAnalyzing(key);
    void ensureNativeApi()
      .prHub.analyzeAdvisories({ keys: [key], mode: "force" })
      .then((result) =>
        queryClient.setQueryData(prHubAdvisoriesQueryOptions([key]).queryKey, result),
      )
      .catch(() => {})
      .finally(() => setAnalyzing((current) => (current === key ? null : current)));
  }, [key, queryClient]);
  return {
    advisory: key ? query.data?.advisories.find((advisory) => advisory.key === key) : undefined,
    isAnalyzing: analyzing !== null && analyzing === key,
    analyze,
  };
}
