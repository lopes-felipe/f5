import { ProjectId, type UpstreamPortsChanged } from "@t3tools/contracts";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  infiniteQueryOptions,
  queryOptions,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UPSTREAM_INVALIDATION_DEBOUNCE_MS,
  createUpstreamPortsInvalidator,
  upstreamPortsQueryKeys,
} from "./upstreamPortsReactQuery";

const projectId = ProjectId.makeUnsafe("project-1");
const otherProjectId = ProjectId.makeUnsafe("project-2");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createUpstreamPortsInvalidator", () => {
  let queryClient: QueryClient;
  let unsubscribes: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    unsubscribes = [];
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    queryClient.clear();
    vi.useRealTimers();
  });

  /** An observed topics list with `pages` pages loaded; `calls` records requested cursors. */
  async function loadTopics(forProject: ProjectId, pages: number, latencyMs = 0) {
    const calls: number[] = [];
    const observer = new InfiniteQueryObserver(
      queryClient,
      infiniteQueryOptions({
        queryKey: upstreamPortsQueryKeys.topics(forProject, "inbox", {}),
        // Like `listTopics`, consumes the signal so cancellation stops the page loop.
        queryFn: async ({ pageParam, signal }) => {
          void signal;
          calls.push(pageParam);
          if (latencyMs) await sleep(latencyMs);
          return { page: pageParam };
        },
        initialPageParam: 0,
        getNextPageParam: (last) => last.page + 1,
      }),
    );
    unsubscribes.push(observer.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(latencyMs);
    for (let page = 1; page < pages; page += 1) {
      const next = observer.fetchNextPage();
      await vi.advanceTimersByTimeAsync(latencyMs);
      await next;
    }
    calls.length = 0;
    return { observer, calls };
  }

  /** An observed query whose fetches take `latencyMs`; tracks overlap and aborts. */
  function observe(queryKey: readonly unknown[], latencyMs: number) {
    const stats = { started: 0, completed: 0, aborted: 0, inFlight: 0, maxInFlight: 0 };
    const observer = new QueryObserver(
      queryClient,
      queryOptions({
        queryKey,
        queryFn: async ({ signal }) => {
          stats.started += 1;
          stats.inFlight += 1;
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
          await sleep(latencyMs);
          stats.inFlight -= 1;
          if (signal.aborted) stats.aborted += 1;
          else stats.completed += 1;
          return stats.started;
        },
      }),
    );
    unsubscribes.push(observer.subscribe(() => {}));
    return stats;
  }

  const change = (reason: UpstreamPortsChanged["reason"], forProject = projectId) =>
    ({ projectId: forProject, reason }) satisfies UpstreamPortsChanged;

  it("never refetches topic pages on queue events and joins an in-flight overview fetch", async () => {
    const topics = await loadTopics(projectId, 15);
    const overview = observe(upstreamPortsQueryKeys.overview(projectId), 300);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    for (let elapsed = 0; elapsed < 1_000; elapsed += 100) {
      invalidator.schedule(change("queue-updated"));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(topics.calls).toEqual([]);
    expect(topics.observer.getCurrentResult().data?.pages).toHaveLength(15);
    expect(overview.aborted).toBe(0);
    expect(overview.maxInFlight).toBe(1);
    // The fetch that was in flight when the first event arrived may predate it: one rerun follows.
    expect(overview.completed).toBeGreaterThanOrEqual(2);
    invalidator.dispose();
  });

  it("reloads one page on a content change and reruns a busy project once", async () => {
    const topics = await loadTopics(projectId, 15, 200);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    invalidator.schedule(change("links-updated"));
    await vi.advanceTimersByTimeAsync(UPSTREAM_INVALIDATION_DEBOUNCE_MS + 10);
    // Three more changes while the first reload is in flight collapse into one rerun.
    for (const reason of ["links-updated", "ledger-updated", "links-updated"] as const) {
      invalidator.schedule(change(reason));
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(topics.calls).toEqual([0, 0]);
    expect(topics.observer.getCurrentResult().data?.pages).toEqual([{ page: 0 }]);
    invalidator.dispose();
  });

  it("cancels an in-flight multi-page refetch before reloading the first page", async () => {
    const topics = await loadTopics(projectId, 3, 100);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    void queryClient.refetchQueries({ queryKey: upstreamPortsQueryKeys.all });
    invalidator.schedule(change("ports-updated"));
    await vi.advanceTimersByTimeAsync(2_000);

    // The refetch reached page 1 when the reload ran; page 2 is never requested.
    expect(topics.calls).toEqual([0, 1, 0]);
    expect(topics.observer.getCurrentResult().data?.pages).toEqual([{ page: 0 }]);
    invalidator.dispose();
  });

  it("keeps the topic detail on queue events and refreshes it on content changes", async () => {
    const detail = observe(upstreamPortsQueryKeys.topic(projectId, "pr-1"), 10);
    await vi.advanceTimersByTimeAsync(10);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    invalidator.schedule(change("queue-updated"));
    await vi.advanceTimersByTimeAsync(500);
    expect(detail.started).toBe(1);

    invalidator.schedule(change("links-updated"));
    await vi.advanceTimersByTimeAsync(500);
    expect(detail.started).toBe(2);
    invalidator.dispose();
  });

  it("trims every project's topics and refreshes files on reconnect and midnight", async () => {
    const first = await loadTopics(projectId, 4);
    const second = await loadTopics(otherProjectId, 2);
    const files = observe(upstreamPortsQueryKeys.topicFiles(otherProjectId, "pr-1"), 10);
    await vi.advanceTimersByTimeAsync(10);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    invalidator.schedule();
    await vi.advanceTimersByTimeAsync(500);

    expect(first.calls).toEqual([0]);
    expect(second.calls).toEqual([0]);
    expect(first.observer.getCurrentResult().data?.pages).toHaveLength(1);
    expect(files.started).toBe(2);
    invalidator.dispose();
  });

  it("refreshes only the changed project's queries", async () => {
    const first = await loadTopics(projectId, 2);
    const second = await loadTopics(otherProjectId, 2);
    const otherOverview = observe(upstreamPortsQueryKeys.overview(otherProjectId), 10);
    await vi.advanceTimersByTimeAsync(10);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    invalidator.schedule(change("links-updated"));
    await vi.advanceTimersByTimeAsync(500);

    expect(first.calls).toEqual([0]);
    expect(second.calls).toEqual([]);
    expect(otherOverview.started).toBe(1);
    invalidator.dispose();
  });

  it("stops scheduling once disposed", async () => {
    const topics = await loadTopics(projectId, 2);
    const invalidator = createUpstreamPortsInvalidator(queryClient);

    invalidator.schedule(change("links-updated"));
    invalidator.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(topics.calls).toEqual([]);
  });
});
